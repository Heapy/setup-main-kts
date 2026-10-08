# Setup Kotlin Scripting

Set up Java and Kotlin for `.main.kts` scripts, with separate caches for the Kotlin
compiler archive, Maven dependencies and compiled scripts. Works on GitHub-hosted
Linux, macOS and Windows runners.

## Usage

Check out your repository before setup so the action can hash your scripts.
Use `Heapy/setup-main-kts@v1`:

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: Heapy/setup-main-kts@v1
    with:
      kotlin-version: '2.4.20'
      java-version: '25'
      distribution: temurin
  - run: kotlinr scripts/check.main.kts
```

Use verified release commit SHAs in maintained workflows. This repository pins
its own action dependencies; Dependabot checks them weekly.

The action installs the official JVM compiler distribution and verifies its
SHA-256 before extraction, including archives restored from cache. It exports
`KOTLIN_HOME`, adds the compiler's `bin` directory to `PATH`, and exports
`KOTLIN_MAIN_KTS_COMPILED_SCRIPTS_CACHE_DIR`. It provides `kotlinr` for older
compiler releases too. `kotlinc` and the legacy `kotlin` command are also available.
Use `kotlinr` for scripts and `./kotlin` for a project's Kotlin Toolchain wrapper.

Scripts run in subsequent steps, so arguments, environment variables, working
directory and exit status follow normal GitHub Actions behavior. The action does
not execute your scripts during setup. The first execution resolves dependencies
and compiles; unchanged scripts reuse compiled bytecode.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `kotlin-version` | `2.4.20` | Exact compiler release; no floating `latest` |
| `kotlin-sha256` | Official release checksum | Optional pinned SHA-256 for the compiler ZIP |
| `java-version` | `25` | Version accepted by `actions/setup-java` |
| `distribution` | `temurin` | JDK distribution accepted by `actions/setup-java` |
| `setup-java` | `true` | Set `false` to reuse an existing `JAVA_HOME` |
| `toolchain-java-home` | `false` | Export `KOTLIN_CLI_JAVA_HOME` using the selected JDK |
| `cache` | `true` | Enable all cross-job caching |
| `cache-dependencies` | `true` | Cache `~/.m2/repository` |
| `cache-compiled-scripts` | `true` | Cache compiled scripts |
| `cache-dependency-path` | `**/*.main.kts` | Newline-separated `hashFiles` patterns relative to the workspace |
| `cache-compiler-options` | Empty | Compiler flags/classpath identity to include in the compiled cache key |
| `cache-key-suffix` | Empty | Extra namespace to invalidate all caches |
| `cache-read-only` | `auto` | `true`, `false`, or `auto` |

`cache: false` disables cross-job caching. Scripts can still use their local
compiled cache within the job. If no files match `cache-dependency-path`, setup
warns and disables cross-job compiled caching; compiler/dependency caching and
script execution still work. Use setup once per job, after generating any scripts
whose contents need to participate in the key.

## Caching

The compiler archive uses an exact key containing OS, architecture, Kotlin
version, checksum and the optional suffix. The Maven cache adds a script hash
and can fall back to an older dependency cache within the same namespace.

Compiled scripts use **exact matches only**. Their key includes OS, architecture,
Kotlin version/checksum, the selected JDK's `release` metadata and path, workspace
and runtime paths, script hash, compiler-option identity and suffix. Paths are
included because compiled scripts can refer to absolute dependency paths.
The action clears its own compiled directory before restoring, preventing stale
local bytecode on persistent runners. It never clears the Maven repository.

Include every imported script, local dependency JAR and compiler plugin in the
hash patterns. Declare command-line compiler options separately, because the
native main-kts cache does not reliably invalidate when those flags change:

```yaml
- uses: Heapy/setup-main-kts@v1
  with:
    cache-dependency-path: |
      scripts/**/*.main.kts
      scripts/**/*.kts
      tools/*.jar
    cache-compiler-options: '-Xplugin=tools/custom-plugin.jar'
- run: kotlinr -Xplugin=tools/custom-plugin.jar scripts/check.main.kts
```

`cache-compiler-options` only identifies the cache; it does not pass flags to the
runner. If scripts, imported files or flags will change after setup, disable
cross-job compiled caching and clear the local compiled cache before executing
with the changed inputs. Otherwise a job could save bytecode under its original
setup-time key. Use pinned Maven dependency versions; mutable
SNAPSHOTs and external local repositories need their own invalidation policy.

`actions/cache` saves at the end of a successful job, after your script steps.
`cache-read-only: auto` restores only for PRs and unknown event types; push,
scheduled and manually dispatched workflows may save. Keys omit branch names;
GitHub's cache access rules govern which base-branch caches can be restored.
No broad fallback is used for compiled bytecode. Cache credentials are never
needed as action inputs, and only the Maven repository is cached, not settings.xml.

Maven settings are preserved by Java setup (`overwrite-settings: false`). If your
resolver uses a custom local repository, disable `cache-dependencies` and cache
that directory separately. This action does not also manage the JDK download
cache; installation and local tool-cache reuse are delegated to `setup-java`.

## Sharing Java with Kotlin Toolchain

```yaml
- uses: Heapy/setup-main-kts@v1
  with:
    java-version: '25'
    toolchain-java-home: 'true'
- run: kotlinr scripts/check.main.kts
- run: ./kotlin build
```

Kotlin Toolchain can use this JDK for builds when `settings.jvm.jdk` matches it
and `selectionMode` is `auto` or `javaHome`. The optional export also selects it
for the Toolchain CLI itself; the JDK must satisfy that CLI version's runtime
requirements. Toolchain installation and caching remain separate.

If Java was already selected earlier in the job, use `setup-java: 'false'`.

## Outputs

`kotlin-version`, `kotlin-home`, `java-home`, `compiled-cache-path`,
`compiler-cache-hit`, `dependencies-cache-hit`, and `compiled-cache-hit`.
Cache-hit outputs are `true` on exact matches, `false` on a fallback, and may be
empty when disabled or not found.

## Development

Requires Node.js 22+, Bash, a JDK and `unzip` (Linux/macOS) or PowerShell 7
(Windows). GitHub-hosted runners provide these; self-hosted runners must also
meet the runtime requirements of the pinned `setup-java` and `cache` actions.
There are no npm dependencies or generated bundles.

```sh
npm test
npm run check
actionlint .github/workflows/ci.yml
# Uses JAVA_HOME, downloads a compiler and resolves fixture dependencies:
npm run integration
```

CI runs unit tests and real scripts on three operating systems, verifies warm
bytecode reuse, and on trusted events checks cache save/restore across fresh jobs.
A legacy Kotlin/JDK job exercises the `kotlinr` compatibility wrapper.

Before publishing, require green CI, create a versioned release and deliberately
update the `v1` tag. Kotlin is a trademark of the Kotlin Foundation. This action
is an independent community project, licensed under Apache-2.0.
