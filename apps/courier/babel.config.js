// The Expo preset; jest-expo transforms the sources with it too.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
