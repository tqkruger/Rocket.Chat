const appModulePath = Npm.require('app-module-path');
appModulePath.addPath(`${ process.cwd() }/node_modules/`);

const Future = Npm.require('fibers/future');
const fs = Plugin.fs;
const path = Plugin.path;
const postCSS = Npm.require('postcss');
const sourcemap = Npm.require('source-map');

const PACKAGES_FILE = 'package.json';

const packageFile = path.resolve(process.cwd(), PACKAGES_FILE);

const loadJSONFile = function(filePath) {
	let content;
	try {
		content = fs.readFileSync(filePath);
		try {
			return JSON.parse(content);
		} catch (e) {
			console.log('Error: failed to parse ', filePath, ' as JSON');
			return {};
		}
	} catch (e) {
		return false;
	}
};

let postcssConfigPlugins;
let postcssConfigParser;
let postcssConfigExcludedPackages;

const jsonContent = loadJSONFile(packageFile);

if (typeof jsonContent === 'object') {
	postcssConfigPlugins = jsonContent.postcss && jsonContent.postcss.plugins;
	postcssConfigParser = jsonContent.postcss && jsonContent.postcss.parser;
	postcssConfigExcludedPackages = jsonContent.postcss && jsonContent.postcss.excludedPackages;
}

const getPostCSSPlugins = function() {
	const plugins = [];
	if (postcssConfigPlugins) {
		Object.keys(postcssConfigPlugins).forEach(function(pluginName) {
			const postCSSPlugin = Npm.require(pluginName);
			if (postCSSPlugin && postCSSPlugin.name === 'creator' && postCSSPlugin().postcssPlugin) {
				plugins.push(postCSSPlugin(postcssConfigPlugins ? postcssConfigPlugins[pluginName] : {}));
			}
		});
	}
	return plugins;
};

const getPostCSSParser = function() {
	let parser = null;
	if (postcssConfigParser) {
		parser = Npm.require(postcssConfigParser);
	}
	return parser;
};

const isNotInExcludedPackages = function(excludedPackages, pathInBundle) {
	let processedPackageName;
	let exclArr = [];
	if (excludedPackages && excludedPackages instanceof Array) {
		exclArr = excludedPackages.map(packageName => {
			processedPackageName = packageName && packageName.replace(':', '_');
			return pathInBundle && pathInBundle.indexOf(`packages/${ processedPackageName }`) > -1;
		});
	}
	return exclArr.indexOf(true) === -1;
};


const getExcludedPackages = function() {
	let excluded = null;
	if (postcssConfigExcludedPackages && postcssConfigExcludedPackages instanceof Array) {
		excluded = postcssConfigExcludedPackages;
	}
	return excluded;
};

// Lints CSS files and merges them into one file, fixing up source maps and
// pulling any @import directives up to the top since the CSS spec does not
// allow them to appear in the middle of a file.
const mergeCss = function(css) {
	// Filenames passed to AST manipulator mapped to their original files
	const originals = {};
	const excludedPackagesArr = getExcludedPackages();

	const cssAsts = css.map(function(file) {
		const filename = file.getPathInBundle();
		originals[filename] = file;

		const f = new Future;

		let css;
		let postres;
		let isFileForPostCSS;

		if (isNotInExcludedPackages(excludedPackagesArr, file.getPathInBundle())) {
			isFileForPostCSS = true;
		} else {
			isFileForPostCSS = false;
		}

		postCSS(isFileForPostCSS ? getPostCSSPlugins() : [])
			.process(file.getContentsAsString(), {
				from: process.cwd() + file._source.url,
				parser: getPostCSSParser()
			})
			.then(function(result) {
				result.warnings().forEach(function(warn) {
					process.stderr.write(warn.toString());
				});
				f.return(result);
			})
			.catch(function(error) {
				let errMsg = error.message;
				if (error.name === 'CssSyntaxError') {
					errMsg = `${ error.message }\n\nCss Syntax Error.\n\n${ error.message }${ error.showSourceCode() }`;
				}
				error.message = errMsg;
				f.return(error);
			});

		try {
			const parseOptions = {
				source: filename,
				position: true
			};

			postres = f.wait();

			if (postres.name === 'CssSyntaxError') {
				throw postres;
			}

			css = postres.css;

			const ast = CssTools.parseCss(css, parseOptions);
			ast.filename = filename;

			return ast;
		} catch (e) {
			if (e.name === 'CssSyntaxError') {
				file.error({
					message: e.message,
					line: e.line,
					column: e.column
				});
			} else if (e.reason) {
				file.error({
					message: e.reason,
					line: e.line,
					column: e.column
				});
			} else {
				// Just in case it's not the normal error the library makes.
				file.error({
					message: e.message
				});
			}

			return {
				type:  'stylesheet',
				stylesheet: {
					rules: []
				},
				filename
			};
		}
	});

	const warnCb = function(filename, msg) {
		// XXX make this a buildmessage.warning call rather than a random log.
		//     this API would be like buildmessage.error, but wouldn't cause
		//     the build to fail.
		console.log(`${ filename }: warn: ${ msg }`);
	};

	const mergedCssAst = CssTools.mergeCssAsts(cssAsts, warnCb);

	// Overwrite the CSS files list with the new concatenated file
	const stringifiedCss = CssTools.stringifyCss(mergedCssAst, {
		sourcemap: true,
		// don't try to read the referenced sourcemaps from the input
		inputSourcemaps: false
	});

	if (!stringifiedCss.code) {
		return {
			code: ''
		};
	}

	// Add the contents of the input files to the source map of the new file
	stringifiedCss.map.sourcesContent =
		stringifiedCss.map.sources.map(function(filename) {
			return originals[filename].getContentsAsString();
		});

	// If any input files had source maps, apply them.
	// Ex.: less -> css source map should be composed with css -> css source map
	const newMap = sourcemap.SourceMapGenerator.fromSourceMap(
		new sourcemap.SourceMapConsumer(stringifiedCss.map));

	Object.keys(originals).forEach(function(name) {
		const file = originals[name];
		if (!file.getSourceMap()) { return false; }

		try {
			newMap.applySourceMap(
				new sourcemap.SourceMapConsumer(file.getSourceMap()), name);
		} catch (err) {
			// If we can't apply the source map, silently drop it.
			//
			// XXX This is here because there are some less files that
			// produce source maps that throw when consumed. We should
			// figure out exactly why and fix it, but this will do for now.
		}
	});

	return {
		code: stringifiedCss.code,
		sourceMap: newMap.toString()
	};
};

const isNotImport = function(inputFileUrl) {
	return !(/\.import\.css$/.test(inputFileUrl) || /(?:^|\/)imports\//.test(inputFileUrl));
};

const isNotLess = function(inputFileUrl) {
	return !/\.less\.css$/.test(inputFileUrl);
};

function CssToolsMinifier() {}

CssToolsMinifier.prototype.processFilesForBundle = function(files, options) {
	const mode = options.minifyMode;

	if (!files.length) { return false; }

	const filesToMerge = files.filter((file) => isNotImport(file._source.url) && isNotLess(file._source.url));

	const merged = mergeCss(filesToMerge);

	if (mode === 'development') {
		files[0].addStylesheet({
			data: merged.code,
			sourceMap: merged.sourceMap,
			path: 'merged-stylesheets.css'
		});
		return;
	}

	const minifiedFiles = CssTools.minifyCss(merged.code);

	if (files.length) {
		minifiedFiles.forEach(function(minified) {
			files[0].addStylesheet({
				data: minified
			});
		});
	}
};

Plugin.registerMinifier({extensions: ['css']}, function() {
	const minifier = new CssToolsMinifier();
	return minifier;
});
