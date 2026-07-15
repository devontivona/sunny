# tool-access Delta Specification

## MODIFIED Requirements

### Requirement: Spawn tools endow attenuated authority through one preset vocabulary
The run-creation tools (`delegate_task`, `schedule_create`) SHALL remain distinct verbs but SHALL share ONE model-facing authority vocabulary: the `toolset` presets (`host` — the default; `readonly` — reads only), each naming a fixed grant bundle, attenuated by intersection with the creator's authority; a scheduled or delegated run never holds the `schedule` or `delegate` grants. **`schedule_create` SHALL additionally expose the audience axis as a `deliver_to` parameter**: a roster name (default: the current subject) routing the fired run's reports to that person's conversation loop, or `nobody` for artifact-producing jobs whose outcomes are inspectable in run history only. The former `for` parameter survives as a deprecated alias of `deliver_to` (a non-strict schema would otherwise silently STRIP the old key from a model imitating recorded history, misrouting the schedule with a success confirmation). The tool's description SHALL teach the report model (a fired run reports to a conversation loop, which relays with context — it does not text anyone directly) and the decision rule: artifact-producing job → `nobody`; message-producing job → a person, with a conditionally-reporting prompt ("report only if X; otherwise reply exactly `<no-report/>`"), never an unconditional "report what was processed". Grants cover only what a run may DO (the authority axis); how a run SPEAKS derives from its audience.

#### Scenario: One vocabulary across spawn verbs
- **WHEN** Sunny delegates a subtask or creates a schedule
- **THEN** both verbs accept the same `toolset` presets with the same default (`host`) and the same attenuation semantics

#### Scenario: A silent pipeline schedule is expressible
- **WHEN** Sunny creates a schedule for a job whose product is an artifact (files, a feed, DB state)
- **THEN** it can pass `deliver_to: nobody`, and the fired runs record outcomes without waking any conversation

#### Scenario: Scheduling for a person routes reports to their loop
- **WHEN** Sunny creates a schedule with `deliver_to: Kate`
- **THEN** the fired run's reports land on Kate's conversation thread and the mediating turn frames its relay for Kate

#### Scenario: A fired schedule acts with its stored authority
- **WHEN** a schedule endowed host grants (e.g. `bash`, `file_read`, `mcp`) fires
- **THEN** the fired run holds exactly those grants' tool bundles, and never the spawn verbs

### Requirement: Messaging tools — one reply lane, one addressed verb, derived from the audience
Outward messaging SHALL be exposed as one reply/report lane and one addressed tool, both delivering through the single delivery bus, and their availability SHALL derive from the run's AUDIENCE (masked by trust), never from an authority grant. The lane is the run's own TEXT: for a conversational turn (a **speaker**) the text a turn ends on IS the reply, gateway-delivered to the thread's human; for every autonomous run (a **reporter**) the text a run ends on IS its report, appended to its audience's conversation loop (or its parent's inbox) and mediated by a conversational turn — an autonomous run SHALL NOT gateway-send its lane text. The one addressed `message(recipient, text)` tool sends to a named other entity (roster ∪ the run's currently-running subagents); a person recipient is resolved in the tool (roster-only, model-facing refusals, self-send guard) and the send itself SHALL ride the bus as deliberate chat speech to the resolved DM (`deliver(chat(byThread))`, persisted). Held by: live-thread conversation turns when trusted (never groups); every scheduled run (a delivering run is refused its own subject — its report already reaches them); a subagent (agent audience of its parent's thread) SHALL NOT hold it. `send_image` SHALL be held only by conversational turns: an autonomous run that produces media references the file in its report, and the mediating turn sends it. Arbitrary (non-roster, non-subagent) recipients SHALL be refused.

#### Scenario: Reply needs no address
- **WHEN** a conversational turn replies to whoever it is currently serving
- **THEN** its reply text is delivered with no recipient argument, resolved from the run's Audience

#### Scenario: A reporter's lane text never reaches the gateway directly
- **WHEN** any autonomous run ends on its report text
- **THEN** the text is appended to its audience's conversation loop (or parent inbox) for mediation, and no gateway send occurs from that run

#### Scenario: One addressed verb reaches a person or a subagent
- **WHEN** Sunny relays to a roster member, or steers one of its running subagents
- **THEN** it calls the same `message(recipient, text)` tool, and the bus delivers to that entity's mailbox

#### Scenario: Media flows through the mediating turn
- **WHEN** a scheduled run produces an image or file the user should see
- **THEN** its report carries the file path, and the mediating conversational turn delivers it via its own `send_image`

#### Scenario: Non-roster recipient refused
- **WHEN** `message` is called with a recipient that is neither a roster member nor one of the run's subagents
- **THEN** it is refused
