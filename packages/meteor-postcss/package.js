Package.describe({
	summary: 'Minifier for Meteor with PostCSS processing',
	version: '0.0.1',
	name: 'rocketchat:postcss',
	git: ''
});

Package.registerBuildPlugin({
	name: 'minifier-postcss',
	use: [
		'ecmascript',
		'minifier-css'
	],
	npmDependencies: {
		'source-map': '0.5.6',
		'postcss': '5.2.17',
		'app-module-path': '2.2.0'
	},
	sources: [
		'plugin/minify-css.js'
	]
});

Package.onUse(function(api) {
	api.use('isobuild:minifier-plugin@1.0.0');
});

