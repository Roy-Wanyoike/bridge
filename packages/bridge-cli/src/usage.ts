/**
 * Usage and help text for the `bridge` CLI. Single source of truth for
 * `bridge help`, `bridge help <command>`, and bare/unknown invocations.
 */

export const GENERAL_USAGE = `bridge — one contract, every language. Bridge IDL command line interface.

Usage: bridge <command> [arguments]

Commands:
  init [dir]                      Scaffold a Bridge project
  validate [files...]             Compile contracts and report diagnostics
  fmt [-w] [files...]             Format Bridge IDL sources (canonical style)
  lint [files...]                 Report errors and convention findings
  generate --language <lang> [file]
                                  Generate Go/Rust/TypeScript/Python code
  diff <old-file> <new-file>      Human-readable compatibility report
  check <old-file> <new-file>     Machine-oriented compatibility gate (CI)
  publish <file> [options]        Publish a contract to the local registry
  pull <package> <version>        Fetch a published contract
  versions <package>              List published versions of a package
  inspect <package> [version]     Show metadata and shape of a contract
  search <query>                  Search published contracts
  doctor [--registry dir]         Check the environment
  version                         Print version information
  help [command]                  Show help for a command

Most commands accept input files; when none are given they fall back to the
"source" configured in bridge.json.

Exit codes: 0 success · 1 error (compile/check failures) · 2 usage error.

Run 'bridge help <command>' for details on a command.
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `bridge init [dir] [--minimal]

Scaffold a Bridge project in <dir> (default: the current directory).

Writes:
  <dir>/bridge.bridge   starter contract (payments example; minimal with --minimal)
  <dir>/bridge.json     project config { version, source, out }

Options:
  --minimal             scaffold a tiny starter contract instead of payments

Prints next steps. Refuses to overwrite existing files (exit 1).`,

  validate: `bridge validate [files...] [--json]

Compile each contract file and report diagnostics with source context.

On success prints:  ✓ <file> ok (package <name>, hash <short>)
On failure prints the compiler diagnostics (file:line:col, message, hint).

Options:
  --json                print a JSON array of
                        { file, ok, package?, hash?, diagnostics } instead

Exit 1 when any file fails to compile.`,

  fmt: `bridge fmt [-w] [files...]

Format Bridge IDL sources into the canonical style (4-space indent, one
field per line, sorted blank-line rules). Without -w prints a unified diff
of what would change and exits 1 when any file needs formatting.

Options:
  -w                    rewrite files in place instead of printing a diff

Exit 1 when a file cannot be parsed, or (without -w) when any file is not
already formatted.`,

  lint: `bridge lint [files...] [--strict]

Compile each file and report warnings and info findings (naming
conventions, deprecations, …) with file:line:col locations.

Options:
  --strict              also fail when only warnings/info are found

Exit codes: 0 clean (warnings tolerated by default); 1 when any error
(or, with --strict, any finding) is reported.`,

  generate: `bridge generate --language <go|rust|typescript|python> [--out dir]
                  [--package-name name] [--force] [file]

Compile a contract and generate a full language project from it.

The output directory defaults to <out from bridge.json, else "generated">
plus "/<language>" (e.g. generated/typescript). With --out the directory
is used exactly as given.

Options:
  --language <lang>     required: go | rust | typescript | python
  --out <dir>           output directory (default generated/<language>)
  --package-name <name> override the derived module/package name
  --force               overwrite existing files

Prints every written path. Exit 1 on compile errors or when an existing
file would be overwritten without --force.`,

  diff: `bridge diff <old-file> <new-file> [--compatible]

Compile both contracts and print the human-readable compatibility report
(SAFE/WARNING/BREAKING/UNKNOWN changes, verdict, gate decision).

Options:
  --compatible          gate on definite breaking changes only (UNKNOWN
                        and WARNING verdicts pass)

Exit 1 when the check fails in the selected mode (default strict).`,

  check: `bridge check <old-file> <new-file> [--compatible] [--json]

Machine-oriented compatibility gate for CI. Prints the verdict, the gate
decision and a change summary; with --json prints
{ package, mode, passed, verdict, summary, changes }.

Options:
  --compatible          gate on definite breaking changes only
  --json                machine-readable output

Exit 1 when the gate fails in the selected mode (default strict).`,

  publish: `bridge publish <file> [--registry dir] [--owner name]
                  [--description text] [--version vX]

Compile a contract and publish it to the local registry (immutable,
content-addressed by the hash of its canonical IR).

The registry root defaults to ./.bridge-registry, overridden by the
BRIDGE_REGISTRY environment variable, then by --registry.

Options:
  --registry <dir>      registry root directory
  --owner <name>        owning team or person
  --description <text>  searchable summary
  --version <vX>        explicit version for names without a version
                        segment (e.g. "payments" needs --version v1)

Exit 1 when the version already exists with different content (versions
are immutable — publish a new version instead).`,

  pull: `bridge pull <package> <version> [--registry dir] [--out file]

Fetch a published contract version. Prints a summary of the stored
metadata and package shape; with --out writes the canonical JSON of the
package IR to a file instead.

Options:
  --registry <dir>      registry root directory
  --out <file>          write canonical IR JSON to this file`,

  versions: `bridge versions <package> [--registry dir]

List all published versions of a package, oldest to newest, marking the
latest. Exit 1 when nothing is published under that name.`,

  inspect: `bridge inspect <package> [version] [--registry dir]

Show the metadata and shape of a published contract: hash, owner,
description, type/method/event counts and imports. Without a version the
latest is inspected.`,

  search: `bridge search <query> [--registry dir]

Substring search (case-insensitive) over published package names,
descriptions and owners. Empty results exit 0.`,

  doctor: `bridge doctor [--registry dir]

Environment diagnostics: node version, workspace package resolution,
compiler and generator smoke test (a minimal schema is compiled and
generated), and registry directory existence/writability.

Prints one ✓/✗ line per check; exit 1 when any check fails.`,

  version: `bridge version

Print the CLI version, generator version and node version.`,

  help: `bridge help [command]

Print the general usage text, or detailed help for one command.`,
};
