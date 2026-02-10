module.exports = {
  env: {
    browser: true,
    webextensions: true,
    es2022: true,
  },
  extends: ["eslint:recommended"],
  parserOptions: { ecmaVersion: 2022, sourceType: "script" },
  ignorePatterns: ["context/", "chrome-extension:/", "pub.mdpi-res.com/"],
  overrides: [
    {
      files: ["background.js", "content.js", "options/*.js"],
      rules: {
        "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      },
    },
  ],
};
