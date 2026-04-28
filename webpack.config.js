const path = require('path');

module.exports = (env, argv) => ({
    entry: './epec_deck_map/EpecDeckMap.react.js',
    output: {
        path: path.resolve(__dirname, 'epec_deck_map'),
        filename: 'epec_deck_map.min.js',
        library: {
            name: 'epec_deck_map',
            type: 'umd',
        },
        globalObject: 'this',
        clean: false,  // do NOT delete __init__.py / EpecDeckMap.py alongside the bundle
    },
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                use: 'babel-loader',
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
        ],
    },
    resolve: {
        extensions: ['.js', '.jsx'],
    },
    externals: {
        react: {
            root:       'React',
            commonjs:   'react',
            commonjs2:  'react',
            amd:        'React',
        },
        'react-dom': {
            root:       'ReactDOM',
            commonjs:   'react-dom',
            commonjs2:  'react-dom',
            amd:        'ReactDOM',
        },
    },
    devtool: argv.mode === 'development' ? 'inline-source-map' : false,
    performance: {
        maxAssetSize:      6_000_000,
        maxEntrypointSize: 6_000_000,
    },
});
