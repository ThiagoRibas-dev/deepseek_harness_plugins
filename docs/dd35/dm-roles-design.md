# D&D 3.5e Solo DM Preset: Core Roles Architecture & Design Specification

## 1. Overview & Purpose

This document defines the core functional architecture for [`plugins/dsh-dd35-preset`](plugins/dsh-dd35-preset/) organized around five distinct Dungeon Master roles:

1. **World Builder**
2. **Simulation Engine**
3. **Storyteller**
4. **Arbiter**
5. **Rules Teacher**

In a tabletop roleplaying game, rules and mechanics are interwoven through every role:
- They establish **verisimilitude and internal consistency** for the World Builder (CR, wealth by level, settlement demographics, spell tiers).
- They define the **laws and physics** of the world for the Simulation Engine (turn order, saving throws, damage, status conditions, decaying tension).
- They establish **fairness and boundaries** for the Storyteller (consequences driven by mechanics, player sovereignty).
- They provide the **baseline for rulings and improvisation** for the Arbiter (differentiating clever tactical play from unintended game exploits).
- They provide the **system knowledge** that the Rules Teacher communicates to the player.

Structuring the preset around these five roles ensures that every lifecycle hook, tool registration, prompt section, and validation routine has a clear functional owner.

---

## 2. The Five Core Roles

```
               +--------------------------------------------------+
               |                     ARBITER                      |
               | (Adjudication, Edge Cases, Exploits vs Creative) |
               +------------------------+-------------------------+
                                        | overrides / rulings
+-------------------------+             v            +-------------------------+
|      WORLD BUILDER      | <---> [ MECHANICS ] <--> |    SIMULATION ENGINE    |
| (Continuity, NPCs, Map) |                          | (Combat, Clocks, World) |
+-------------------------+                          +-------------------------+
            |                                                     |
            | scene context & entities                            | mechanical outcomes
            v                                                     v
+------------------------------------------------------------------------------+
|                                 STORYTELLER                                  |
|            (Prose Discipline, Sensory Economy, Player Sovereignty)           |
+------------------------------------------------------------------------------+
                                        |
                                        v (narration to player)
                                   [ PLAYER ]
                                        | (rules clarification)
                                        v
+------------------------------------------------------------------------------+
|                                RULES TEACHER                                 |
|                       (Out-of-Character Explanations)                        |
+------------------------------------------------------------------------------+
```

---

### 2.1 Role 1: World Builder

#### Definition & Scope
The World Builder creates and maintains the campaign setting, locations, factions, non-player characters (NPCs), and narrative scaffolding. Session preparation and runtime continuity require constructing and updating a persistent model of the game world.

#### Relationship to Mechanics
The World Builder uses D&D 3.5e mechanics to ensure verisimilitude:
- NPCs have valid Challenge Ratings (CR), classes, levels, ability scores, and spell selections.
- Settlements conform to Dungeon Master's Guide (DMG) population and wealth limits.
- Factions operate within resource and personnel budgets.
- Dungeons and encounter sites present hazards appropriate to party level.

#### Inputs
- Campaign persona: `campaign/<id>/dm_persona.md`.
- Campaign notes: `campaign/<id>/dm_notes.md`.
- Entity records: stored character sheets (`state-store.js`).
- Past session transcripts and episodic memories (`memory.js`).
- Reference SRD rules, monsters, and classes (`reference.js`).

#### Outputs
- Entity definitions created via `create_entity` and modified via `update_entity`.
- Active scene descriptors registered via `update_scene`.
- Campaign scope and metadata managed via `create_campaign`, `set_active_campaign`, `detach_campaign`.
- Episodic memories persisted to disk via `commitTurn()`.
- Bounded NPC signature kits (≤ 4 items) serialized into prompt context.
- Segmented turn graphs distinguishing `witnesses` from `mentioned_actors`.

#### Associated Tools
- [`state.js`](plugins/dsh-dd35-preset/state.js): `create_campaign`, `list_campaigns`, `set_active_campaign`, `detach_campaign`, `create_entity`, `get_entity`, `update_entity`, `update_scene`.
- [`names.js`](plugins/dsh-dd35-preset/names.js): `generate_character_name`, `generate_place_name`.
- [`reference.js`](plugins/dsh-dd35-preset/reference.js): `get_monster`, `get_class`, `get_spell`, `search_reference`, `list_reference_categories`.
- [`doctor.js`](plugins/dsh-dd35-preset/doctor.js): `dd35_doctor` (canon audits, entity validation, orphan detection).
- [`memory.js`](plugins/dsh-dd35-preset/memory.js): `grep_memories`, `fetch_memories`, `list_memories`.

#### Prompt Directives & Constraints
- Anchor all characters, locations, and factions in concrete 3.5e parameters rather than vague descriptors.
- Restrict NPC active gear and abilities to signature kits of ≤ 4 items in active prompts to prevent entity inflation.
- Check previous turn memories and scene state before introducing characters or locations to preserve timeline continuity.

---

### 2.2 Role 2: Simulation Engine

#### Definition & Scope
The Simulation Engine advances active game state deterministically and models consequences: tactical combat, environmental hazards, passage of time, condition decay, resource depletion, and off-screen pacing. Mechanics serve as the physical and magical laws governing the world.

#### Relationship to Mechanics
The Simulation Engine is the primary executor of mechanical rules:
- Resolves attacks against Armor Class (AC), saving throws against Difficulty Class (DC), and opposed skill checks.
- Tracks turn order, rounds, initiative, hit point loss, temporary hit points, and conditions.
- Executes tension checks via decaying DCs without requiring manual model intervention.

#### Inputs
- Current tactical mode: `exploration` or `combat` (`set_mode`).
- Active combat roster: combatants, initiative scores, current turn/round (`state.combat`).
- Combatant sheets: HP, AC, saving throws, damage reductions, active conditions.
- Seeded turn counters and PRNG state.
- Tension state: `state.tension = { surpriseDC, encounterDC, worldEventDC }`.

#### Outputs
- Initiative order and round advancement (`next_turn`, `next_round`, `adjust_initiative`).
- HP and condition changes (`apply_damage`, `heal`, `apply_condition`, `remove_condition`, `tick_conditions`).
- Automated tension events (`[SURPRISE EVENT]`, `[ENCOUNTER EVENT]`, `[WORLD_EVENT]`).
- Check and attack roll outcomes (`roll_check`, `roll_attack`, `roll_dice`).

#### Associated Tools
- [`mechanics.js`](plugins/dsh-dd35-preset/mechanics.js): `roll_check`, `roll_attack`, `init_combat`, `next_turn`, `next_round`, `adjust_initiative`, `end_combat`, `apply_damage`, `heal`, `apply_condition`, `remove_condition`, `tick_conditions`, `add_combatant`, `remove_combatant`.
- [`tools.js`](plugins/dsh-dd35-preset/tools.js): `roll_dice`.
- [`state.js`](plugins/dsh-dd35-preset/state.js): `get_state`, `set_mode`, `route_turn`.
- [`oracle-core.js`](plugins/dsh-dd35-preset/oracle-core.js): `evaluateTensionTick(state, seed)`.

#### Prompt Directives & Constraints
- Never narrate physical damage, healing, or condition application without executing the matching tool call (`apply_damage`, `heal`, `apply_condition`).
- Strictly adhere to rolled outcomes: a missed attack or failed save cannot be narrated as a success.
- Execute tension rolls at turn boundaries to ensure deterministic world momentum.

---

### 2.3 Role 3: Storyteller

#### Definition & Scope
The Storyteller translates the state and events produced by the Simulation Engine and World Builder into engaging narrative fiction. It controls sensory framing, pacing, atmosphere, and dialogue for present NPCs.

#### Relationship to Mechanics
The Storyteller respects mechanical outcomes as hard boundaries:
- A character at 0 HP cannot be narrated as standing or fighting.
- A failed Stealth check dictates that the guard has detected the character.
- Table dials (`difficulty`, `spotlight`, `pacing`, `scope`) guide narrative consequence severity, scene brevity, and the scale of the stakes.

#### Inputs
- Simulation Engine outcomes (rolls, damage amounts, condition changes, tension events).
- Active scene context: present actors (`witnesses`), environment, sensory details.
- Player actions and spoken dialogue.
- Session dials: `difficulty` (casual/standard/gritty), `spotlight` (focused/ensemble), `pacing` (deliberate/brisk), `scope` (local/regional/national/planar/continental).
- Active dramatic arc: current beat (1 through 6) and act (1 through 3).

#### Outputs
- Final narrative prose delivered to the player chat stream.

#### Associated Tools
- Directly executes no state mutation tools during prose output.
- Reads context injected through `dd35:scene-state`, `dd35:dm-persona`, and `dd35:dm-notes`.
- May consult oracles for improvisational prompts: `ask_oracle`, `consult_oracle`.

#### Prompt Directives & Constraints
- **Pure Table Prose**: Do not use markdown headings (`#`, `##`, `###`) or bullet points inside narrative fiction. Use prose paragraphs only.
- **Sensory Economy**: Restrict scene descriptions to 2–3 sharp, specific sensory details (sound, smell, light, texture) before prompting action.
- **Strict Player Sovereignty**: Never narrate player character actions, spoken dialogue, emotions, or internal thoughts. The player owns the character's internal life and choices completely.
- **Transition Bangs**: Conclude every scene or turn with a concrete development, immediate choice, or NPC prompt. Avoid ending on passive inquiries like "What do you do?".

---

### 2.4 Role 4: Arbiter

#### Definition & Scope
The Arbiter applies judgment when the written rules do not fit the fiction, edge cases arise, or a player attempts an uncodified creative maneuver. The Arbiter sits above the Simulation Engine and has the authority to improvise, modify, or bend rules, set situational DCs, and distinguish creative tactical play from game exploits.

#### Relationship to Mechanics
The Arbiter enforces the spirit of the rules over rigid literalism:
- When rules are silent, the Arbiter invents a fair ruling, assigns a difficulty or probability roll, and adjudicates the result.
- When mechanics allow an unintended loop or exploit, the Arbiter denies the exploit while preserving reasonable actions.
- Replaces rigid "no DM fiat" mandates with principled adjudication.

#### Inputs
- Player action statements involving uncodified actions or creative physics appeals.
- Conflict or ambiguity between written rules.
- Simulation engine limitations.
- Rules reference texts retrieved via `lookup_rule`.

#### Outputs
- Situational rulings, custom DCs, and circumstance modifiers (+2 circumstance bonus, -4 improvised tool penalty).
- Adjudication rolls requested via `roll_check` or `roll_dice`.
- Out-of-character rationale when denying an exploit or approving a novel maneuver.

#### Associated Tools
- [`reference.js`](plugins/dsh-dd35-preset/reference.js): `lookup_rule`.
- [`mechanics.js`](plugins/dsh-dd35-preset/mechanics.js): `roll_check` (with situational DC).
- [`tools.js`](plugins/dsh-dd35-preset/tools.js): `roll_dice` (probability rolls).

#### Prompt Directives & Constraints
- Distinguish creative problem-solving (reward with appropriate DCs or circumstance bonuses) from mechanical exploits (firmly deny and explain why).
- When rules do not clearly address an action, assign a DC based on standard tiers (Easy 10, Moderate 15, Hard 20, Heroic 25, Epic 30) or roll a percentile probability die.
- State rulings clearly and proceed; do not derail the game with prolonged theoretical arguments.

---

### 2.5 Role 5: Rules Teacher

#### Definition & Scope
The Rules Teacher explains 3.5e mechanics, action economies, and character options to the player upon request or when a player's proposed action involves severe mechanical pitfalls (such as provoking attacks of opportunity or failing casting prerequisites).

#### Relationship to Mechanics
The Rules Teacher serves as an accessible index and tutorial for 3.5e mechanics, explaining how the numbers and systems function without interrupting dramatic flow.

#### Inputs
- Explicit player questions regarding rules, feats, spells, or combat maneuvers.
- Proposed actions that would trigger punitive or misunderstood mechanics (e.g., attempting to cast a spell with somatic components while grappled).
- Reference lookups: `lookup_rule`, `get_class`, `get_spell`.

#### Outputs
- Concise mechanical explanations, calculations, or rules citations.

#### Associated Tools
- [`reference.js`](plugins/dsh-dd35-preset/reference.js): `lookup_rule`, `get_spell`, `get_class`, `get_monster`, `search_reference`.

#### Prompt Directives & Constraints
- Separate out-of-character mechanical explanations from in-character narrative prose (use brief bracketed notes or separate OOC paragraphs).
- Warn players proactively when an intended action incurs a major mechanical penalty (e.g., "Note: Moving through that threatened square will provoke an Attack of Opportunity from the bugbear.").
- Keep explanations brief and reference the relevant rule or modifier directly.

---

## 3. Four Operational Modes of Play

D&D 3.5e operates across four distinct operational modes, each with defined time scales, action structures, procedural skill checks, and role responsibilities.

### 3.1 Mode 1: Combat / Encounter

#### Time Scale & Structure
- **Round Duration**: 6 seconds per round. 10 rounds equal 1 minute.
- **Turn Sequence**: Determined by initiative check ($d20 + \text{DEX modifier} + \text{Misc}$). Highest roll acts first. Ties broken by highest DEX modifier, then reroll.

#### Action Economy
Each participant has an allotment of actions each round:
1. **Standard Action**: Make one attack, cast a spell (1 standard action casting time), use a supernatural ability, or perform a total defense (+4 dodge bonus to AC).
2. **Move Action**: Move up to base land speed, draw or sheathe a weapon (free with BAB +1 or higher while moving), retrieve a stored item, or direct an active spell.
3. **Full-Round Action**: Requires the entire turn. Examples include Full Attack (all iterative attacks), Run (4× speed in straight line), Charge (double speed straight toward enemy, +2 attack, -2 AC), Withdraw (first square moved is not threatened), and casting 1-round spells.
4. **Swift Action**: Consumes a small amount of time, maximum one per turn (e.g., casting a Quickened spell or certain martial stances).
5. **Immediate Action**: Can be taken at any time, even on another character's turn. Uses the character's swift action for their next turn (e.g., *feather fall*).
6. **Free Actions**: Minor actions requiring negligible effort (dropping an item, speaking a brief phrase).
7. **5-Foot Step**: A 5-foot movement taken only when no other movement is made during the turn. Does not provoke attacks of opportunity.

#### Tactical Rules & Triggers
- **Attacks of Opportunity (AoO)**:
  - Moving out of a threatened square without a 5-foot step, withdraw action, or tumble check provokes an AoO.
  - Performing distracting actions in a threatened square (casting a spell, making a ranged attack, drinking a potion, standing from prone) provokes an AoO.
  - Baseline limit: 1 AoO per round, unless modified by the Combat Reflexes feat.
- **Defensive Casting**:
  - A caster in a threatened square can avoid provoking an AoO by casting defensively.
  - Requires a Concentration check: $\text{DC} = 15 + \text{Spell Level}$.
  - Failure results in the loss of the spell slot with no effect.
- **Tumble Maneuvers**:
  - Move through threatened squares without provoking: Tumble DC 15 (moved at half speed).
  - Move through an enemy's occupied square: Tumble DC 25 (moved at half speed).
  - Failing by 1 or more provokes the AoO normally. Accelerating to full speed increases the DC by +10.

#### Role Responsibilities in Combat
- **Simulation Engine**: Manages initiative roster (`init_combat`, `next_turn`), tracks round counts, computes iterative attacks, deducts HP via `apply_damage`, tracks active conditions.
- **Arbiter**: Evaluates cover (+4 AC for standard cover), concealment (20% or 50% miss chance), flanking (+2 attack bonus for opposing positions), and improvisational maneuvers.
- **Rules Teacher**: Warns player when a proposed movement or spell provokes an AoO before locking in the action.

---

### 3.2 Mode 2: Exploration / Dungeon

#### Time Scale & Structure
- **Turn Duration**: 10 minutes per dungeon exploration turn.
- **Pacing**: Characters navigate corridors, search for secrets, listen at doors, and manage consumables (torches, rations, light spells).

#### Vision, Illumination, and Concealment
- **Torches**: 20 ft bright illumination radius, 20 ft additional shadowy illumination radius. Burns for 1 hour.
- **Bullseye Lantern**: 60 ft cone of bright illumination, 60 ft cone of shadowy illumination. Burns for 6 hours per pint of oil.
- **Hooded Lantern**: 30 ft bright illumination radius, 30 ft shadowy illumination radius.
- **Darkvision**: Black-and-white vision up to 60 ft (or racial limit) in complete non-magical darkness.
- **Low-Light Vision**: Doubles illumination radii of torches and lanterns.
- **Concealment Penalties**:
  - Shadowy illumination grants Concealment: 20% miss chance on attacks, allows Hide checks.
  - Total darkness grants Total Concealment: 50% miss chance, full blindness to creatures without darkvision, -2 AC, lose DEX to AC, move at half speed.

#### Perception & Stealth
- **Spot & Listen**: Opposed by enemy Hide & Move Silently checks.
  - Distance modifier: -1 to Listen and Spot per 10 feet of distance.
  - Door or wall barrier: +5 DC to Listen through a door; +10 through a stone wall.
- **Search vs. Disable Device**:
  - Search identifies traps, hidden compartments, and secret doors. Inspecting a 5-foot square takes 1 full-round action (or 10 minutes for an entire room).
  - **Trapfinding**: Only Rogues (and classes with the Trapfinding class feature) can use Search to find mechanical or magical traps with DC > 20.
  - Disable Device resolves disarming or jamming mechanisms. Failure by 5 or more immediately triggers the trap.

#### Procedural Resolutions
- **Take 10**: Permitted when the character is not in immediate danger, threatened, or distracted. The character treats the die roll as a 10.
- **Take 20**: Permitted when the task carries no penalty for failure and can be attempted repeatedly. Consumes 20 times the standard duration (e.g., searching a 5-ft square takes 20 rounds / 2 minutes).

#### Role Responsibilities in Exploration
- **Simulation Engine**: Advances dungeon turn clocks, ticks decaying tension DCs, decrements torch and spell durations.
- **World Builder**: Supplies layout descriptions, door states, atmospheric textures, and acoustic cues.
- **Storyteller**: Limits descriptions to 2–3 sensory details per chamber, providing clear interactive choices at exits.

---

### 3.3 Mode 3: Social / Interaction

#### Time Scale & Structure
- **Turn Duration**: Flexible, proceeding by conversational exchange or 1-minute blocks.
- **Focus**: NPC motivations, bargaining, information gathering, and persuasion.

#### NPC Attitude Track
NPCs occupy one of five attitude states toward the player character:
1. **Hostile**: Will take risks to hurt, deceive, or disrupt the party.
2. **Unfriendly**: Wishes ill, refuses cooperation, unhelpful.
3. **Indifferent**: Uninvested, strictly transactional or neutral.
4. **Friendly**: Cooperative, willing to offer reasonable aid.
5. **Helpful**: Devoted ally, willing to take personal risks to assist.

#### Social Skill Resolution
- **Diplomacy**:
  - Used to improve an NPC's attitude. Requires 1 full minute of conversation.
  - Baseline DCs:
    - Hostile to Indifferent: DC 25 (Hostile to Unfriendly: DC 20)
    - Unfriendly to Indifferent: DC 15 (Unfriendly to Friendly: DC 25)
    - Indifferent to Friendly: DC 20 (Indifferent to Helpful: DC 30)
    - Friendly to Helpful: DC 30
  - Rushed Diplomacy: Can be executed as a full-round action with a -10 penalty on the check.
  - Retries: If the check fails, the NPC's attitude cannot be improved again during the same encounter.
- **Bluff vs. Sense Motive**:
  - Opposed skill check. Bluff is modified by believability:
    - Target wants to believe: +5
    - Plausible statement: +0
    - Difficult to believe: -5
    - Highly improbable: -10
    - Impossible: -20
  - In combat, Bluff allows a Feint (standard action) to deny the opponent's DEX bonus to AC on the next melee attack.
- **Intimidate**:
  - **Out of Combat (Coerce)**: Requires 1 minute. Opposed by $1d20 + \text{target's HD} + \text{target's WIS modifier} + \text{target's save bonus vs fear}$. Success changes attitude to Friendly for $1d6 \times 10$ minutes, after which the attitude drops to Unfriendly.
  - **In Combat (Demoralize)**: Standard action, melee reach. Opposed check as above. Success leaves the target shaken (-2 on attacks, saves, checks) for 1 round.
- **Gather Information**:
  - Used to unearth rumors, local gossip, and leads within a community.
  - Takes $1d4+1$ hours and expenditures of gold (typically 1d4 gp).
  - DC 10 (general gossip), DC 15 (specific rumors), DC 20 (confidential lore), DC 25+ (obscure or dangerous secrets).

#### Role Responsibilities in Social Mode
- **Storyteller**: Portrays NPC dialogue, manners, body language, and immediate emotional reactions.
- **Simulation Engine**: Rolls opposed checks and updates the tracked attitude state.
- **Arbiter**: Assigns circumstance bonuses (+2 for presenting aligned incentives, -2 for cultural insults).

---

### 3.4 Mode 4: Travel & Downtime

#### Time Scale & Structure
- **Turn Duration**: Hours, days, weeks, or months.
- **Focus**: Overland journeys, long-term healing, crafting, research, and resource management.

#### Overland Travel & Pacing
- **Travel Speed**: Dependent on base land speed across standard 8-hour travel days:
  - Base Speed 20 ft: 2 miles per hour, 16 miles per day.
  - Base Speed 30 ft: 3 miles per hour, 24 miles per day.
  - Base Speed 40 ft: 4 miles per hour, 32 miles per day.
- **Terrain Modifiers**:
  - Highway/Paved: ×1.0
  - Trail/Open Plains: ×1.0
  - Forest/Hills/Desert: ×0.5 (half speed)
  - Mountains/Swamp: ×0.5 (half speed)
  - Trackless Jungle/Alpine: ×0.25 (one-quarter speed)
- **Forced March**:
  - Traveling more than 8 hours in a single day requires a Fortitude save each hour beyond the 8th.
  - $\text{DC} = 10 + 2 \text{ per hour past 8}$.
  - Failure deals $1d6$ nonlethal damage and inflicts the Fatigued condition. Characters cannot recover from this nonlethal damage until they stop and rest for 8 hours.

#### Rest, Healing, and Resource Recovery
- **8-Hour Rest**:
  - Recovers 1 HP per character level.
  - Recovers 1 point of ability damage per damaged ability score.
  - Refreshes daily spell slots, psionic power points, and per-day class abilities.
  - Interrupted sleep: An interruption of 1 hour or more requires an additional hour of rest to gain benefits.
- **Complete Bed Rest (24 Hours)**:
  - Recovers 2 HP per character level.
  - Recovers 2 points of ability damage per damaged ability score.

#### Environmental Exposure & Survival
- **Extreme Cold/Heat**: Fortitude save each hour (DC 15, +1 per previous check) or suffer $1d6$ nonlethal damage.
- **Foraging (Survival)**:
  - Survival check DC 10 provides sufficient food and water for one person while traveling at half speed.
  - Every 2 points by which the check beats DC 10 provides sustenance for one additional person.
- **Route Finding**: Survival DC 15 to avoid getting lost in featureless wilderness (mountains, thick forests, open sea).

#### Role Responsibilities in Travel & Downtime
- **Simulation Engine**: Computes miles traversed, deducts rations, rolls hourly forced march saves, calculates HP recovered during rest.
- **World Builder**: Tracks geographic landmarks, weather shifts, faction actions, and background rumor generation.
- **Storyteller**: Condenses long journeys into short evocative transition passages, stopping only for significant decision points.

---

## 4. Core Fundamental Mechanics Index

This index codifies the mathematical chassis of D&D 3.5e into concise formulas. By placing these core formulas in prompt memory, the preset prunes massive static progression tables from the system prompt while maintaining rule fidelity. Granular tables (e.g. 20-level class tables, spell lists, monster statblocks) are queried on demand via `reference.js`.

### 4.1 The Core Resolution Mechanic
$$\text{Resolution Roll} = d20 + \text{Base Bonus (BAB or Ranks)} + \text{Ability Modifier} + \text{Misc Modifiers} \ge \text{Target Number (DC or AC)}$$

- **Critical Hits & Fumbles**:
  - Natural 20 is an automatic hit on attack rolls and automatic success on saving throws. On attack rolls, a natural 20 threatens a critical hit; roll to confirm against the target's AC.
  - Natural 1 is an automatic miss on attack rolls and automatic failure on saving throws.
  - **Skill Check Exception**: Skill checks do not have automatic success on natural 20 or automatic failure on natural 1.

### 4.2 DC Benchmarks
| Difficulty Tier | Target DC | Description & Context |
|---|:---:|---|
| **Very Easy** | 5 | Climbing a knotted rope, noticing something in plain sight. |
| **Easy** | 10 | Climbing a rough natural wall, hearing a guard approaching. |
| **Moderate** | 15 | Picking an average lock, hearing a stealthy enemy, stabilizing an ally. |
| **Hard** | 20 | Disarming an intricate trap, swimming against a fast river, jumping a 20-ft gap. |
| **Very Hard** | 25 | Picking a masterwork lock, recalling obscure ancient history. |
| **Heroic** | 30 | Tracking across bare granite after rain, identifying legendary artifacts. |
| **Epic / Impossible** | 35+ | Balancing on a razor's edge, swimming up a waterfall. |

### 4.3 Ability Scores & Modifiers
$$\text{Ability Modifier} = \left\lfloor \frac{\text{Score} - 10}{2} \right\rfloor$$

- **Strength (STR)**: Melee attack rolls, melee and thrown damage, Climb, Jump, Swim, carrying capacity.
- **Dexterity (DEX)**: Ranged attack rolls, Armor Class, Reflex saves, Initiative, Balance, Escape Artist, Hide, Move Silently, Open Lock, Ride, Sleight of Hand, Tumble, Use Rope.
- **Constitution (CON)**: Bonus HP per Hit Die, Fortitude saves, Concentration checks.
- **Intelligence (INT)**: Bonus skill points, spellcasting (Wizard), Appraise, Craft, Decipher Script, Disable Device, Forgery, Knowledge, Search, Spellcraft.
- **Wisdom (WIS)**: Will saves, divine spellcasting (Cleric, Druid), Autohypnosis, Heal, Listen, Profession, Sense Motive, Spot, Survival.
- **Charisma (CHA)**: Social interactions, turn undead, spontaneous spellcasting (Sorcerer, Bard), Bluff, Diplomacy, Disguise, Gather Information, Handle Animal, Intimidate, Perform, Use Magic Device.

### 4.4 Combat Chassis & Progressions

#### Base Attack Bonus (BAB) Progressions
- **Full BAB** ($1.0 \times \text{Level}$): Fighter, Barbarian, Paladin, Ranger.
  - Level 1: +1, Level 5: +5, Level 10: +10, Level 15: +15, Level 20: +20.
- **3/4 BAB** ($\lfloor 0.75 \times \text{Level} \rfloor$): Cleric, Rogue, Bard, Monk, Druid.
  - Level 1: +0, Level 5: +3, Level 10: +7, Level 15: +11, Level 20: +15.
- **1/2 BAB** ($\lfloor 0.5 \times \text{Level} \rfloor$): Wizard, Sorcerer.
  - Level 1: +0, Level 5: +2, Level 10: +5, Level 15: +7, Level 20: +10.

#### Iterative Attacks (Full Attack Action)
Iterative attacks are unlocked whenever the character's Base Attack Bonus reaches +6, +11, and +16:
- BAB +1 to +5: 1 attack (+BAB)
- BAB +6 to +10: 2 attacks (+BAB / +BAB - 5)
- BAB +11 to +15: 3 attacks (+BAB / +BAB - 5 / +BAB - 10)
- BAB +16 to +20: 4 attacks (+BAB / +BAB - 5 / +BAB - 10 / +BAB - 15)

#### Saving Throw Progressions
- **Good Save**: $2 + \left\lfloor \frac{\text{Level}}{2} \right\rfloor$
  - Level 1: +2, Level 5: +4, Level 10: +7, Level 15: +9, Level 20: +12.
- **Poor Save**: $\left\lfloor \frac{\text{Level}}{3} \right\rfloor$
  - Level 1: +0, Level 5: +1, Level 10: +3, Level 15: +5, Level 20: +6.

#### Armor Class (AC) Variants
- **Standard AC**: $10 + \text{Armor} + \text{Shield} + \text{Dexterity Mod} + \text{Size Mod} + \text{Natural Armor} + \text{Deflection} + \text{Dodge/Misc}$
- **Touch AC**: Ignores Armor, Shield, and Natural Armor. Retains Dexterity Mod, Size Mod, Deflection, and Dodge bonuses.
- **Flat-Footed AC**: Ignores Dexterity Mod and Dodge bonuses. Retains Armor, Shield, Natural Armor, Size Mod, and Deflection.

#### Spell Difficulty Class (DC)
$$\text{Spell Save DC} = 10 + \text{Spell Level} + \text{Key Caster Ability Modifier}$$

### 4.5 On-Demand Reference Tool Triggers
Static progression tables, monster statblocks, spell catalogs, and class ability charts must not be permanently embedded in the system prompt. Instead, the DM model queries them dynamically:
- When a spell is cast or examined: Call `get_spell(spell_name)`.
- When an NPC or monster is encountered: Call `get_monster(monster_name)`.
- When checking class features, multiclass requirements, or level progression: Call `get_class(class_name)`.
- When verifying rules for grappling, sundering, mounted combat, or conditions: Call `lookup_rule(topic, category)`.
- When searching general SRD keywords: Call `search_reference(query)`.

This strategy confines the resting prompt prefix to ~2,300 tokens while maintaining accurate access to the entire D&D 3.5e SRD.

---

## 5. Comprehensive Role Matrix

| Dimension | Role 1: World Builder | Role 2: Simulation Engine | Role 3: Storyteller | Role 4: Arbiter | Role 5: Rules Teacher |
|---|---|---|---|---|---|
| **Primary Responsibility** | Environment, NPCs, setting, continuity, adventure scaffolding | Deterministic state tracking, combat, resource decay, tension | Prose presentation, sensory description, pacing, dialogue | Rulings, edge cases, custom DCs, exploit prevention | Rules explanations and tactical guidance to player |
| **How Mechanics Intersect** | Verisimilitude: CR, classes, demographics, monster stats | Engine laws: Turn order, AC, saves, HP, tension DCs | Guardrails: Honors damage, status, and failed checks | Adjudication: Balances RAW with creative intent | Knowledge: Explains 3.5e systems and action costs |
| **Active Mode** | Pre-turn / Scene transition / Post-turn | Live turn path (deterministic) | Post-simulation prose output | On-demand / Edge cases | On-demand / Clarifications |
| **Key Inputs** | `dm_notes.md`, `entities/`, transcripts, reference data | Combat state, entity HP, DCs, turn counter, seed | Simulation outcomes, active witnesses, table dials | Player appeals, uncodified actions, rule ambiguities | Player questions, rules reference lookup results |
| **Key Outputs** | Entity sheets, scene descriptors, memory logs, graph edges | Roll results, HP/condition mutations, tension tags | Narrative text, transition bangs, NPC dialogue | Custom DCs, circumstance modifiers, rulings | Concise OOC explanations, mechanic warnings |
| **Primary Tools** | `create_entity`, `update_scene`, `dd35_doctor`, `get_monster` | `roll_check`, `roll_attack`, `apply_damage`, `init_combat` | `consult_oracle` (optional flavor only) | `lookup_rule`, `roll_check`, `roll_dice` | `lookup_rule`, `get_spell`, `get_class` |
| **Prompt Section / Files** | `prompt.js` (`dd35:dm-notes`), `scene-state.js` | `cordis.patch.yml` (mechanics summary), `state.js` | `cordis.patch.yml` (prose discipline), `prompt.js` | `cordis.patch.yml` (adjudication directives) | `cordis.patch.yml` (OOC guidance) |

---

## 6. Mapping of Roadmap Items to Functional Roles

Organizing roadmap improvements by DM role clarifies the implementation sequence and ensures every component serves a distinct purpose:

### World Builder Enhancements
- **NPC Signature Kit Bounds (P2-1)**: Enforce ≤ 4 items per NPC in prompt contexts to prevent entity bloat.
- **Gate 1 Canon Diagnostics (P2-2)**: Audit entities in `doctor.js` for unvetted mutations or equipment drift.
- **Witness vs. Mentioned Boundaries (P3-1)**: Partition turn entities into `witnesses` and `mentioned_actors` with scene hysteresis.
- **Memory Scoping & Prefork Protection (M-1 to M-4)**: Isolate episodic memories per session (`session:<id>`) and guard `agent/turn-stopping` with `inheritedEventCount` to prevent fork duplication.

### Simulation Engine Enhancements
- **Decaying-DC Tension Engine (P1-1 to P1-3)**: Implement 3-tier decaying-DC loops (Ambient, Tactical, World) in `oracle-core.js` and `tables.json`.
- **Wire Payload Safety (P1-4)**: Cap tool responses at 16,384 bytes with safe boundary truncation to avoid RPC timeouts.
- **Automated Turn-Start Tick (P1-3, REC-10)**: Evaluate tension decay deterministically on the turn boundary.

### Storyteller Enhancements
- **Narrative Craft Directives (P2-3)**: Inject pure table prose (no `#` or bullets in fiction), sensory economy (2–3 details), and transition bangs into `cordis.patch.yml`.
- **Strict Player Sovereignty (P2-3)**: Explicitly forbid narrating player character actions, words, or emotions.
- **Table Dials & Arc Tracking (P3-2, P3-3)**: Add `state.dials` (`difficulty`, `spotlight`, `pacing`, `scope`) and 6-beat dramatic arc progression.

### Arbiter Enhancements
- **Adjudication Directives Overhaul (P2-4)**: Replace "rather than DM fiat" with principled adjudication rules for setting DCs, assigning circumstance bonuses, and distinguishing exploits from creative problem-solving.
- **Static Rules Pruning (P2-4)**: Prune BAB and save progression tables from `cordis.patch.yml`, directing mechanical lookups to `lookup_rule` and `reference.js`.

### Rules Teacher Enhancements
- **Clear OOC Boundaries (P2-3, P2-4)**: Provide guidance on formatting rules advice distinctly from narrative prose.
- **Proactive Mechanics Warnings**: Direct the model to alert players to severe action penalties before resolving fatal mistakes.

---

## 7. Architectural Verification & Quality Invariants

When implementing changes for any role, the following architectural invariants must remain satisfied:

1. **Subtractive Zero-Inference**: No role may introduce a secondary LLM call, background agent, or vector embedding on the live turn path. All mechanics, tension ticks, and doctor diagnostics run in deterministic Node.js / SQLite.
2. **Context Freeze**: Dynamic context contributions from the World Builder, Simulation Engine, or Arbiter must freeze on the turn boundary via `createTurnFrozenContext` to prevent mid-turn prompt cache invalidation.
3. **Payload Capping**: Every tool result returning variable-length data must enforce `capToolOutput(payload, 16384)`.
4. **Prompt Budget**: The resting prompt prefix must stay near ~2,300 tokens by offloading reference tables to on-demand tools.
5. **Session Isolation**: All state mutations and memory captures must respect session boundaries and `inheritedEventCount`.
