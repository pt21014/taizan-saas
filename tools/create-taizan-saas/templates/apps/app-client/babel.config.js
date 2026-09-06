module.exports = function (api) {
  api.cache(true)
  // expo-router 从 SDK 50 起已并入 babel-preset-expo，不需要额外挂 'expo-router/babel'。
  return {
    presets: ['babel-preset-expo'],
  }
}
