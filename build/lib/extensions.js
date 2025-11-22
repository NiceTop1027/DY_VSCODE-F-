import es from "event-stream";
import fs from "fs";
import cp from "child_process";
import glob from "glob";
import gulp from "gulp";
import path from "path";
import crypto from "crypto";
import { Stream } from "stream";
import File from "vinyl";
import { createStatsStream } from "./stats.ts";
import * as util2 from "./util.ts";
import filter from "gulp-filter";
import rename from "gulp-rename";
import fancyLog from "fancy-log";
import ansiColors from "ansi-colors";
import buffer from "gulp-buffer";
import * as jsoncParser from "jsonc-parser";
import webpack from "webpack";
import { getProductionDependencies } from "./dependencies.ts";
import { getExtensionStream } from "./builtInExtensions.ts";
import { getVersion } from "./getVersion.ts";
import { fetchUrls, fetchGithub } from "./fetch.ts";
import vzip from "gulp-vinyl-zip";
import { createRequire } from "module";
const require2 = createRequire(import.meta.url);
const root = path.dirname(path.dirname(import.meta.dirname));
const commit = getVersion(root);
const sourceMappingURLBase = `https://main.vscode-cdn.net/sourcemaps/${commit}`;
function minifyExtensionResources(input) {
  const jsonFilter = filter(["**/*.json", "**/*.code-snippets"], { restore: true });
  return input.pipe(jsonFilter).pipe(buffer()).pipe(es.mapSync((f) => {
    const errors = [];
    const value = jsoncParser.parse(f.contents.toString("utf8"), errors, { allowTrailingComma: true });
    if (errors.length === 0) {
      f.contents = Buffer.from(JSON.stringify(value));
    }
    return f;
  })).pipe(jsonFilter.restore);
}
function updateExtensionPackageJSON(input, update) {
  const packageJsonFilter = filter("extensions/*/package.json", { restore: true });
  return input.pipe(packageJsonFilter).pipe(buffer()).pipe(es.mapSync((f) => {
    const data = JSON.parse(f.contents.toString("utf8"));
    f.contents = Buffer.from(JSON.stringify(update(data)));
    return f;
  })).pipe(packageJsonFilter.restore);
}
function fromLocal(extensionPath, forWeb, disableMangle) {
  const webpackConfigFileName = forWeb ? `extension-browser.webpack.config.js` : `extension.webpack.config.js`;
  const isWebPacked = fs.existsSync(path.join(extensionPath, webpackConfigFileName));
  let input = isWebPacked ? fromLocalWebpack(extensionPath, webpackConfigFileName, disableMangle) : fromLocalNormal(extensionPath);
  if (isWebPacked) {
    input = updateExtensionPackageJSON(input, (data) => {
      delete data.scripts;
      delete data.dependencies;
      delete data.devDependencies;
      if (data.main) {
        data.main = data.main.replace("/out/", "/dist/");
      }
      return data;
    });
  }
  return input;
}
function fromLocalWebpack(extensionPath, webpackConfigFileName, disableMangle) {
  const vsce = require2("@vscode/vsce");
  const webpack2 = require2("webpack");
  const webpackGulp = require2("webpack-stream");
  const result = es.through();
  const packagedDependencies = [];
  const packageJsonConfig = require2(path.join(extensionPath, "package.json"));
  if (packageJsonConfig.dependencies) {
    const webpackRootConfig = require2(path.join(extensionPath, webpackConfigFileName)).default;
    for (const key in webpackRootConfig.externals) {
      if (key in packageJsonConfig.dependencies) {
        packagedDependencies.push(key);
      }
    }
  }
  vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.None, packagedDependencies }).then((fileNames) => {
    const files = fileNames.map((fileName) => path.join(extensionPath, fileName)).map((filePath) => new File({
      path: filePath,
      stat: fs.statSync(filePath),
      base: extensionPath,
      contents: fs.createReadStream(filePath)
    }));
    const webpackConfigLocations = glob.sync(
      path.join(extensionPath, "**", webpackConfigFileName),
      { ignore: ["**/node_modules"] }
    );
    const webpackStreams = webpackConfigLocations.flatMap((webpackConfigPath) => {
      const webpackDone = (err, stats) => {
        fancyLog(`Bundled extension: ${ansiColors.yellow(path.join(path.basename(extensionPath), path.relative(extensionPath, webpackConfigPath)))}...`);
        if (err) {
          result.emit("error", err);
        }
        const { compilation } = stats;
        if (compilation.errors.length > 0) {
          result.emit("error", compilation.errors.join("\n"));
        }
        if (compilation.warnings.length > 0) {
          result.emit("error", compilation.warnings.join("\n"));
        }
      };
      const exportedConfig = require2(webpackConfigPath).default;
      return (Array.isArray(exportedConfig) ? exportedConfig : [exportedConfig]).map((config) => {
        const webpackConfig = {
          ...config,
          ...{ mode: "production" }
        };
        if (disableMangle) {
          if (Array.isArray(config.module.rules)) {
            for (const rule of config.module.rules) {
              if (Array.isArray(rule.use)) {
                for (const use of rule.use) {
                  if (String(use.loader).endsWith("mangle-loader.js")) {
                    use.options.disabled = true;
                  }
                }
              }
            }
          }
        }
        const relativeOutputPath = path.relative(extensionPath, webpackConfig.output.path);
        return webpackGulp(webpackConfig, webpack2, webpackDone).pipe(es.through(function(data) {
          data.stat = data.stat || {};
          data.base = extensionPath;
          this.emit("data", data);
        })).pipe(es.through(function(data) {
          if (path.extname(data.basename) === ".js") {
            const contents = data.contents.toString("utf8");
            data.contents = Buffer.from(contents.replace(/\n\/\/# sourceMappingURL=(.*)$/gm, function(_m, g1) {
              return `
//# sourceMappingURL=${sourceMappingURLBase}/extensions/${path.basename(extensionPath)}/${relativeOutputPath}/${g1}`;
            }), "utf8");
          }
          this.emit("data", data);
        }));
      });
    });
    es.merge(...webpackStreams, es.readArray(files)).pipe(result);
  }).catch((err) => {
    console.error(extensionPath);
    console.error(packagedDependencies);
    result.emit("error", err);
  });
  return result.pipe(createStatsStream(path.basename(extensionPath)));
}
function fromLocalNormal(extensionPath) {
  const vsce = require2("@vscode/vsce");
  const result = es.through();
  vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Npm }).then((fileNames) => {
    const files = fileNames.map((fileName) => path.join(extensionPath, fileName)).map((filePath) => new File({
      path: filePath,
      stat: fs.statSync(filePath),
      base: extensionPath,
      contents: fs.createReadStream(filePath)
    }));
    es.readArray(files).pipe(result);
  }).catch((err) => result.emit("error", err));
  return result.pipe(createStatsStream(path.basename(extensionPath)));
}
const userAgent = "VSCode Build";
const baseHeaders = {
  "X-Market-Client-Id": "VSCode Build",
  "User-Agent": userAgent,
  "X-Market-User-Id": "291C1CD0-051A-4123-9B4B-30D60EF52EE2"
};
function fromMarketplace(serviceUrl, { name: extensionName, version, sha256, metadata }) {
  const json = require2("gulp-json-editor");
  const [publisher, name] = extensionName.split(".");
  const url = `${serviceUrl}/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`;
  fancyLog("Downloading extension:", ansiColors.yellow(`${extensionName}@${version}`), "...");
  const packageJsonFilter = filter("package.json", { restore: true });
  return fetchUrls("", {
    base: url,
    nodeFetchOptions: {
      headers: baseHeaders
    },
    checksumSha256: sha256
  }).pipe(vzip.src()).pipe(filter("extension/**")).pipe(rename((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe(buffer()).pipe(json({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
function fromVsix(vsixPath, { name: extensionName, version, sha256, metadata }) {
  const json = require2("gulp-json-editor");
  fancyLog("Using local VSIX for extension:", ansiColors.yellow(`${extensionName}@${version}`), "...");
  const packageJsonFilter = filter("package.json", { restore: true });
  return gulp.src(vsixPath).pipe(buffer()).pipe(es.mapSync((f) => {
    const hash = crypto.createHash("sha256");
    hash.update(f.contents);
    const checksum = hash.digest("hex");
    if (checksum !== sha256) {
      throw new Error(`Checksum mismatch for ${vsixPath} (expected ${sha256}, actual ${checksum}))`);
    }
    return f;
  })).pipe(vzip.src()).pipe(filter("extension/**")).pipe(rename((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe(buffer()).pipe(json({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
function fromGithub({ name, version, repo, sha256, metadata }) {
  const json = require2("gulp-json-editor");
  fancyLog("Downloading extension from GH:", ansiColors.yellow(`${name}@${version}`), "...");
  const packageJsonFilter = filter("package.json", { restore: true });
  return fetchGithub(new URL(repo).pathname, {
    version,
    name: (name2) => name2.endsWith(".vsix"),
    checksumSha256: sha256
  }).pipe(buffer()).pipe(vzip.src()).pipe(filter("extension/**")).pipe(rename((p) => p.dirname = p.dirname.replace(/^extension\/?/, ""))).pipe(packageJsonFilter).pipe(buffer()).pipe(json({ __metadata: metadata })).pipe(packageJsonFilter.restore);
}
const nativeExtensions = [
  "microsoft-authentication"
];
const excludedExtensions = [
  "vscode-api-tests",
  "vscode-colorize-tests",
  "vscode-colorize-perf-tests",
  "vscode-test-resolver",
  "ms-vscode.node-debug",
  "ms-vscode.node-debug2"
];
const marketplaceWebExtensionsExclude = /* @__PURE__ */ new Set([
  "ms-vscode.node-debug",
  "ms-vscode.node-debug2",
  "ms-vscode.js-debug-companion",
  "ms-vscode.js-debug",
  "ms-vscode.vscode-js-profile-table"
]);
const productJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../product.json"), "utf8"));
const builtInExtensions = productJson.builtInExtensions || [];
const webBuiltInExtensions = productJson.webBuiltInExtensions || [];
function isWebExtension(manifest) {
  if (Boolean(manifest.browser)) {
    return true;
  }
  if (Boolean(manifest.main)) {
    return false;
  }
  if (typeof manifest.extensionKind !== "undefined") {
    const extensionKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
    if (extensionKind.indexOf("web") >= 0) {
      return true;
    }
  }
  if (typeof manifest.contributes !== "undefined") {
    for (const id of ["debuggers", "terminal", "typescriptServerPlugins"]) {
      if (manifest.contributes.hasOwnProperty(id)) {
        return false;
      }
    }
  }
  return true;
}
function packageNonNativeLocalExtensionsStream(forWeb, disableMangle) {
  return doPackageLocalExtensionsStream(forWeb, disableMangle, false);
}
function packageNativeLocalExtensionsStream(forWeb, disableMangle) {
  return doPackageLocalExtensionsStream(forWeb, disableMangle, true);
}
function packageAllLocalExtensionsStream(forWeb, disableMangle) {
  return es.merge([
    packageNonNativeLocalExtensionsStream(forWeb, disableMangle),
    packageNativeLocalExtensionsStream(forWeb, disableMangle)
  ]);
}
function doPackageLocalExtensionsStream(forWeb, disableMangle, native) {
  const nativeExtensionsSet = new Set(nativeExtensions);
  const localExtensionsDescriptions = glob.sync("extensions/*/package.json").map((manifestPath) => {
    const absoluteManifestPath = path.join(root, manifestPath);
    const extensionPath = path.dirname(path.join(root, manifestPath));
    const extensionName = path.basename(extensionPath);
    return { name: extensionName, path: extensionPath, manifestPath: absoluteManifestPath };
  }).filter(({ name }) => native ? nativeExtensionsSet.has(name) : !nativeExtensionsSet.has(name)).filter(({ name }) => excludedExtensions.indexOf(name) === -1).filter(({ name }) => builtInExtensions.every((b) => b.name !== name)).filter(({ manifestPath }) => forWeb ? isWebExtension(require2(manifestPath)) : true);
  const localExtensionsStream = minifyExtensionResources(
    es.merge(
      ...localExtensionsDescriptions.map((extension) => {
        return fromLocal(extension.path, forWeb, disableMangle).pipe(rename((p) => p.dirname = `extensions/${extension.name}/${p.dirname}`));
      })
    )
  );
  let result;
  if (forWeb) {
    result = localExtensionsStream;
  } else {
    const productionDependencies = getProductionDependencies("extensions/");
    const dependenciesSrc = productionDependencies.map((d) => path.relative(root, d)).map((d) => [`${d}/**`, `!${d}/**/{test,tests}/**`]).flat();
    result = es.merge(
      localExtensionsStream,
      gulp.src(dependenciesSrc, { base: "." }).pipe(util2.cleanNodeModules(path.join(root, "build", ".moduleignore"))).pipe(util2.cleanNodeModules(path.join(root, "build", `.moduleignore.${process.platform}`)))
    );
  }
  return result.pipe(util2.setExecutableBit(["**/*.sh"]));
}
function packageMarketplaceExtensionsStream(forWeb) {
  const marketplaceExtensionsDescriptions = [
    ...builtInExtensions.filter(({ name }) => forWeb ? !marketplaceWebExtensionsExclude.has(name) : true),
    ...forWeb ? webBuiltInExtensions : []
  ];
  const marketplaceExtensionsStream = minifyExtensionResources(
    es.merge(
      ...marketplaceExtensionsDescriptions.map((extension) => {
        const src = getExtensionStream(extension).pipe(rename((p) => p.dirname = `extensions/${p.dirname}`));
        return updateExtensionPackageJSON(src, (data) => {
          delete data.scripts;
          delete data.dependencies;
          delete data.devDependencies;
          return data;
        });
      })
    )
  );
  return marketplaceExtensionsStream.pipe(util2.setExecutableBit(["**/*.sh"]));
}
function scanBuiltinExtensions(extensionsRoot, exclude = []) {
  const scannedExtensions = [];
  try {
    const extensionsFolders = fs.readdirSync(extensionsRoot);
    for (const extensionFolder of extensionsFolders) {
      if (exclude.indexOf(extensionFolder) >= 0) {
        continue;
      }
      const packageJSONPath = path.join(extensionsRoot, extensionFolder, "package.json");
      if (!fs.existsSync(packageJSONPath)) {
        continue;
      }
      const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath).toString("utf8"));
      if (!isWebExtension(packageJSON)) {
        continue;
      }
      const children = fs.readdirSync(path.join(extensionsRoot, extensionFolder));
      const packageNLSPath = children.filter((child) => child === "package.nls.json")[0];
      const packageNLS = packageNLSPath ? JSON.parse(fs.readFileSync(path.join(extensionsRoot, extensionFolder, packageNLSPath)).toString()) : void 0;
      const readme = children.filter((child) => /^readme(\.txt|\.md|)$/i.test(child))[0];
      const changelog = children.filter((child) => /^changelog(\.txt|\.md|)$/i.test(child))[0];
      scannedExtensions.push({
        extensionPath: extensionFolder,
        packageJSON,
        packageNLS,
        readmePath: readme ? path.join(extensionFolder, readme) : void 0,
        changelogPath: changelog ? path.join(extensionFolder, changelog) : void 0
      });
    }
    return scannedExtensions;
  } catch (ex) {
    return scannedExtensions;
  }
}
function translatePackageJSON(packageJSON, packageNLSPath) {
  const CharCode_PC = "%".charCodeAt(0);
  const packageNls = JSON.parse(fs.readFileSync(packageNLSPath).toString());
  const translate = (obj) => {
    for (const key in obj) {
      const val = obj[key];
      if (Array.isArray(val)) {
        val.forEach(translate);
      } else if (val && typeof val === "object") {
        translate(val);
      } else if (typeof val === "string" && val.charCodeAt(0) === CharCode_PC && val.charCodeAt(val.length - 1) === CharCode_PC) {
        const translated = packageNls[val.substr(1, val.length - 2)];
        if (translated) {
          obj[key] = typeof translated === "string" ? translated : typeof translated.message === "string" ? translated.message : val;
        }
      }
    }
  };
  translate(packageJSON);
  return packageJSON;
}
const extensionsPath = path.join(root, "extensions");
const esbuildMediaScripts = [
  "ipynb/esbuild.mjs",
  "markdown-language-features/esbuild-notebook.mjs",
  "markdown-language-features/esbuild-preview.mjs",
  "markdown-math/esbuild.mjs",
  "mermaid-chat-features/esbuild-chat-webview.mjs",
  "notebook-renderers/esbuild.mjs",
  "simple-browser/esbuild-preview.mjs"
];
async function webpackExtensions(taskName, isWatch, webpackConfigLocations) {
  const webpack2 = require2("webpack");
  const webpackConfigs = [];
  for (const { configPath, outputRoot } of webpackConfigLocations) {
    let addConfig2 = function(configOrFnOrArray2) {
      for (const configOrFn of Array.isArray(configOrFnOrArray2) ? configOrFnOrArray2 : [configOrFnOrArray2]) {
        const config = typeof configOrFn === "function" ? configOrFn({}, {}) : configOrFn;
        if (outputRoot) {
          config.output.path = path.join(outputRoot, path.relative(path.dirname(configPath), config.output.path));
        }
        webpackConfigs.push(config);
      }
    };
    var addConfig = addConfig2;
    const configOrFnOrArray = require2(configPath).default;
    addConfig2(configOrFnOrArray);
  }
  function reporter(fullStats) {
    if (Array.isArray(fullStats.children)) {
      for (const stats of fullStats.children) {
        const outputPath = stats.outputPath;
        if (outputPath) {
          const relativePath = path.relative(extensionsPath, outputPath).replace(/\\/g, "/");
          const match = relativePath.match(/[^\/]+(\/server|\/client)?/);
          fancyLog(`Finished ${ansiColors.green(taskName)} ${ansiColors.cyan(match[0])} with ${stats.errors.length} errors.`);
        }
        if (Array.isArray(stats.errors)) {
          stats.errors.forEach((error) => {
            fancyLog.error(error);
          });
        }
        if (Array.isArray(stats.warnings)) {
          stats.warnings.forEach((warning) => {
            fancyLog.warn(warning);
          });
        }
      }
    }
  }
  return new Promise((resolve, reject) => {
    if (isWatch) {
      webpack2(webpackConfigs).watch({}, (err, stats) => {
        if (err) {
          reject();
        } else {
          reporter(stats?.toJson());
        }
      });
    } else {
      webpack2(webpackConfigs).run((err, stats) => {
        if (err) {
          fancyLog.error(err);
          reject();
        } else {
          reporter(stats?.toJson());
          resolve();
        }
      });
    }
  });
}
async function esbuildExtensions(taskName, isWatch, scripts) {
  function reporter(stdError, script) {
    const matches = (stdError || "").match(/\> (.+): error: (.+)?/g);
    fancyLog(`Finished ${ansiColors.green(taskName)} ${script} with ${matches ? matches.length : 0} errors.`);
    for (const match of matches || []) {
      fancyLog.error(match);
    }
  }
  const tasks = scripts.map(({ script, outputRoot }) => {
    return new Promise((resolve, reject) => {
      const args = [script];
      if (isWatch) {
        args.push("--watch");
      }
      if (outputRoot) {
        args.push("--outputRoot", outputRoot);
      }
      const proc = cp.execFile(process.argv[0], args, {}, (error, _stdout, stderr) => {
        if (error) {
          return reject(error);
        }
        reporter(stderr, script);
        return resolve();
      });
      proc.stdout.on("data", (data) => {
        fancyLog(`${ansiColors.green(taskName)}: ${data.toString("utf8")}`);
      });
    });
  });
  return Promise.all(tasks);
}
async function buildExtensionMedia(isWatch, outputRoot) {
  return esbuildExtensions("esbuilding extension media", isWatch, esbuildMediaScripts.map((p) => ({
    script: path.join(extensionsPath, p),
    outputRoot: outputRoot ? path.join(root, outputRoot, path.dirname(p)) : void 0
  })));
}
export {
  buildExtensionMedia,
  fromGithub,
  fromMarketplace,
  fromVsix,
  packageAllLocalExtensionsStream,
  packageMarketplaceExtensionsStream,
  packageNativeLocalExtensionsStream,
  packageNonNativeLocalExtensionsStream,
  scanBuiltinExtensions,
  translatePackageJSON,
  webpackExtensions
};
