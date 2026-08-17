// Metro in a pnpm workspace: the app imports `@betterwakeup/contract` from
// source, so Metro has to watch the repository root and resolve modules from
// both the app's own `node_modules` and the root store the workspace links into.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// pnpm links every dependency as a symlink; resolving to the real path keeps
// one copy of React in the graph.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
