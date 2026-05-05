import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptFilePath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFilePath);
const extensionDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(extensionDirectory, '../..');
const stageDirectory = path.join(extensionDirectory, '.vsix-stage');
const stageDistDirectory = path.join(stageDirectory, 'dist');
const artifactsDirectory = path.join(extensionDirectory, 'artifacts');
const extensionPackagePath = path.join(extensionDirectory, 'package.json');
const repositoryReadmePath = path.join(repositoryRoot, 'README.md');

const sourceManifest = JSON.parse(readFileSync(extensionPackagePath, 'utf8'));
const packagingConfig = sourceManifest.llmCranePackaging ?? {};
const extensionName = packagingConfig.name ?? 'llm-crane';
const publisher = packagingConfig.publisher ?? 'llm-crane-local';
const displayName = packagingConfig.displayName ?? sourceManifest.displayName ?? 'LLM Crane';
const description =
  packagingConfig.description ?? sourceManifest.description ?? 'Local-first, developer-first LLM orchestrator for VS Code.';
const repository = packagingConfig.repository;
const categories = packagingConfig.categories ?? ['Other'];
const keywords = packagingConfig.keywords ?? ['llm', 'orchestrator', 'ai', 'vscode'];
const vsixOutputPath = path.join(artifactsDirectory, `${extensionName}-${sourceManifest.version}.vsix`);
const vsceBinaryPath = path.join(
  extensionDirectory,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
);
const workspaceEntryPoints = {
  '@llm-crane/core': path.join(repositoryRoot, 'packages/core/src/index.ts'),
  '@llm-crane/schemas': path.join(repositoryRoot, 'packages/schemas/src/index.ts'),
  '@llm-crane/providers': path.join(repositoryRoot, 'packages/providers/src/index.ts'),
  '@llm-crane/prompts': path.join(repositoryRoot, 'packages/prompts/src/index.ts'),
};

const workspaceAliasPlugin = {
  name: 'llm-crane-workspace-alias',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@llm-crane\// }, (args) => {
      const replacement = workspaceEntryPoints[args.path];
      if (!replacement) {
        return undefined;
      }

      return {
        path: replacement,
      };
    });
  },
};

function createStageManifest() {
  return {
    name: extensionName,
    publisher,
    displayName,
    description,
    version: sourceManifest.version,
    engines: sourceManifest.engines,
    repository,
    categories,
    keywords,
    files: ['dist/**', 'README.md'],
    main: './dist/extension.js',
    activationEvents: sourceManifest.activationEvents,
    contributes: sourceManifest.contributes,
  };
}

async function bundleOutputs() {
  await build({
    entryPoints: [path.join(extensionDirectory, 'src/extension.ts')],
    outfile: path.join(stageDistDirectory, 'extension.js'),
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    sourcemap: false,
    legalComments: 'none',
    plugins: [workspaceAliasPlugin],
  });

  await build({
    entryPoints: [path.join(repositoryRoot, 'apps/orchestrator/src/index.ts')],
    outfile: path.join(stageDistDirectory, 'orchestrator.js'),
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    plugins: [workspaceAliasPlugin],
  });
}

function prepareStageDirectory() {
  rmSync(stageDirectory, { recursive: true, force: true });
  mkdirSync(stageDistDirectory, { recursive: true });
  mkdirSync(artifactsDirectory, { recursive: true });

  writeFileSync(path.join(stageDirectory, 'package.json'), `${JSON.stringify(createStageManifest(), null, 2)}\n`);

  if (existsSync(repositoryReadmePath)) {
    cpSync(repositoryReadmePath, path.join(stageDirectory, 'README.md'));
  }
}

function packageVsix() {
  rmSync(vsixOutputPath, { force: true });
  execFileSync(vsceBinaryPath, ['package', '--skip-license', '--out', vsixOutputPath], {
    cwd: stageDirectory,
    stdio: 'inherit',
  });
}

async function main() {
  prepareStageDirectory();
  await bundleOutputs();
  packageVsix();
  console.log(`VSIX packaged at ${vsixOutputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});