// import { dirname, resolve } from 'path';
// import { fileURLToPath } from 'url';

// const __dirname = dirname(fileURLToPath(import.meta.url));

// export default {
//   mode: 'production',
//   entry: './index.js',
//   output: {
//     filename: 'hiverewards.bundle.js',
//     path: resolve(__dirname, 'dist'),
//     library: {
//       name: 'HiveRewards',
//       type: 'umd',
//     },
//   },
//   experiments: { topLevelAwait: true },
//   resolve: {
//     fallback: {
//       'node-fetch': false, // strip node-only dep from browser bundle
//       util: false,
//       url: false,
//       path: false,
//       fs: false,
//     },
//   },
// };

const path = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  entry: './index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'hiverewards.bundle.js',
    library: 'HiveRewards',
    libraryTarget: 'umd',
    umdNamedDefine: true,
    globalObject: "typeof self !== 'undefined' ? self : this",
  },
  resolve: {
    // make sure require('process/browser') actually finds the browser shim
    alias: {
      'process/browser': require.resolve('process/browser'),
    },
    fallback: {
      crypto:   require.resolve('crypto-browserify'),
      stream:   require.resolve('stream-browserify'),
      assert:   require.resolve('assert/'),
      buffer:   require.resolve('buffer/'),
      util:     require.resolve('util/'),
      vm:       require.resolve('vm-browserify'),
      url:      require.resolve('url/'),
      path:     require.resolve('path-browserify'),
    },
    extensions: ['.js', '.json'],
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
};
