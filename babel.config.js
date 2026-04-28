module.exports = {
    presets: [
        ['@babel/preset-env', {
            targets: { browsers: ['last 2 versions'] },
            modules: false,  // preserve ES modules for webpack tree-shaking
        }],
        ['@babel/preset-react', {
            runtime: 'classic',  // React.createElement; avoids importing react/jsx-runtime
        }],
    ],
};
