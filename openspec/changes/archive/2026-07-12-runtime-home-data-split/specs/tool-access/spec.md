# tool-access delta: file mutation tools refuse the code-managed state repository

## MODIFIED Requirements

### Requirement: Core thin tools (bash, file read)
Sunny SHALL expose capability primarily through a `bash` tool that executes a command on the
host and returns its output, plus thin file primitives: `file-read`, `file-write`, and
`file-edit`. The thin-tool surface SHALL be kept minimal; higher capabilities (browsing,
fetching web pages, email, building sites) SHALL be CLIs driven via bash or `SKILL.md` skills
over bash, NOT dedicated tools — file mutation primitives are part of the minimal surface
itself, not a capability. Web fetching SHALL be performed via bash (e.g. a fetch CLI) or the
browse capability rather than a dedicated `web-fetch` tool. **The one bounded exception is
MCP:** tools fetched from an owner-registered MCP server SHALL be injected into the agent loop
as native tools (an MCP server exposes structured tools with no CLI to shell out to — the
server is the interface), and this exception SHALL apply only to owner-registered MCP servers,
not to any other capability. Any external content entering Sunny's context (fetched pages,
command output that reads remote data, **and MCP tool results**) SHALL be treated as untrusted
data.

The file primitives SHALL behave as follows:

- `file-read` SHALL support line-windowed reading (a 1-based line offset and a line-count
  limit) and SHALL return line-numbered output, with truncation notes that state how to
  continue reading. Binary (non-UTF-8) content SHALL be refused, not decoded.
- `file-write` SHALL create or overwrite a UTF-8 text file, creating missing parent
  directories.
- `file-edit` SHALL replace an exact string in an existing file and SHALL fail — with an
  error the model can recover from — when the target string matches zero times, or matches
  more than once without an explicit replace-all flag. Editing binary content SHALL be
  refused.
- `file-write` and `file-edit` SHALL refuse any target that resolves inside `~/.sunny/state/`
  (the code-managed state repository), with a recoverable error that names `~/.sunny/data/`
  as the home for durable files and `~/.sunny/scratch/` for temporary ones. Resolution SHALL
  be symlink- and `..`-safe (judged against the real path of the deepest existing ancestor),
  and `file-read` SHALL remain unrestricted.
- The file mutation tools SHALL be registered on exactly the surfaces that hold `bash` (the
  same trust gate); they SHALL NOT widen any run's privilege beyond what its bash access
  already grants.

#### Scenario: Bash runs a command and returns output
- **WHEN** Sunny invokes the bash tool with a command
- **THEN** the command runs on the host and its stdout/stderr and exit status are returned

#### Scenario: Windowed, numbered file read
- **WHEN** Sunny reads a file with a line offset and limit
- **THEN** it receives that window of lines, line-numbered, with a note stating how to continue if the file has more lines

#### Scenario: Surgical edit requires a unique match
- **WHEN** Sunny invokes file-edit with a string that occurs more than once (without replace-all) or not at all
- **THEN** the edit is refused with an error stating the match count, and the file is unchanged

#### Scenario: File write creates the file and its directories
- **WHEN** Sunny writes a file whose parent directory does not exist
- **THEN** the directories are created and the file is written with exactly the given content

#### Scenario: Writes into the state repository are refused with redirection
- **WHEN** Sunny invokes file-write or file-edit on a path that resolves inside `~/.sunny/state/` (including via symlink or `..` traversal)
- **THEN** the call fails with a recoverable error naming `~/.sunny/data/` (durable) and `~/.sunny/scratch/` (temporary) as the correct homes
- **AND** the file is unchanged
- **AND** file-read of the same path still succeeds

#### Scenario: File tools ride the bash trust gate
- **WHEN** a run does not have the bash tool (e.g. a readonly or tool-less child)
- **THEN** it has neither file-write nor file-edit

#### Scenario: Fetched content is untrusted
- **WHEN** Sunny fetches a web page (via bash or the browse capability)
- **THEN** the returned content is handled as untrusted data, not as instructions

#### Scenario: MCP is the one non-bash capability
- **WHEN** a capability is delivered as an MCP server's tools
- **THEN** those tools are injected into the agent loop as native tools rather than as a CLI or skill over bash
- **AND** this exception applies only to owner-registered MCP servers

#### Scenario: MCP tool results are untrusted
- **WHEN** an MCP server tool returns a result into Sunny's context
- **THEN** the result is handled as untrusted data, not as instructions
