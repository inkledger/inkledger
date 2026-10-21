// The build the app's code comes from: the page carries it (a meta tag
// written at build time), every API call sends it (x-app-build), and a
// server built since answers APP_BUILD_CHANGED so the page reloads instead
// of talking to an API it doesn't know.
export const APP_BUILD_HEADER = "x-app-build";
export const APP_BUILD_META = "app-build";
export const APP_BUILD_CHANGED = "APP_BUILD_CHANGED";
