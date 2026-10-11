# Resume State
Date: 2026-10-11

## 1. Confirmed Decisions & Approved Model Choices
- User confirmed model choices:
  - **FI-14 (Embeddings / Retrieval)**: `onnx-community/embeddinggemma-2-ONNX` (SHA `daa72c51243991dfcaf9f9137d2c573d8f7790c0`, Apache-2.0, 740M total params, 270M text backbone [130M transformer + 140M embedder], 8,192 token context, unified 768-d space with MRL truncation to 512/256/128-d) adopted as primary text/multimodal encoder. `all-MiniLM-L6-v2` (22M) retained as fallback for low-resource hosts.
  - **FI-10 (Runtime Substrate)**: Document runtime trade-offs between `@huggingface/transformers` (pulls `sharp`, out-of-the-box tokenization & modular vision/audio config pruning via `config.vision_config = config.audio_config = null`) vs standalone `onnxruntime-node` (avoids `sharp`, but requires tokenization handling for 262k vocab).
  - **FI-11 (Decision Model / Oracle)**: Add example-based embedding classifier before Laya; retain Laya for state-dependent decisions.
  - Host benchmark was not approved.
- Policy & Name Generator:
  - `generate_character_name` and `generate_place_name` added to `STRIPPED_TOOLS` in `plugins/dsh-tool-result-policy/policy.js` (committed in `939321a`). All 80 tests passing.

## 2. Global Memory & Retrieval Architecture Intent
- **User's Architectural Direction**:
  - Global queryable interface serving as the shared backend for multiple tools:
    - Specific memory queries (turn memories, campaign events, conversation logs).
    - Knowledge base / document corpus search (rulebooks, reference, lore, notes).
    - Passive contextual recall (querying based on auto-extracted keywords/questions from conversation context).
  - Scope goes beyond D&D 3.5e preset: belongs at host/profile level (global plugin / HTTP service / MCP server).
- **DigUp Hybrid Search Patterns (`ARahim3/DigUp`)**:
  - SQLite FTS5 (Porter stemming, unicode tokenizer, normalized terms, BM25) + dense cosine search over float16 BLOBs.
  - Chunking ~1,800 chars / ~200 overlap. Text gate (<20% letters -> FTS only). Cap 5,000 chunks.
  - Query-adaptive z-score calibration of cosine similarity across corpus. Candidate gate: $z \ge 2.0$ OR keyword coverage $\ge 50\%$.
  - Fusion score: $\max(z, 0) + 2 \times (\text{coverage})^{1.5} + \text{type\_bonus}$ (or ID-weighted variant). Hit policy: 1 hit per source file pointing to best segment.
- **Anonymous Architecture Reference (Shared by User)**:
  - **Memory Server Backend**: Exposes standard HTTP API and MCP to CRUD and search memories. Indexed with EmbeddingGemma, queried with simple natural-language questions.
  - **Pre-Turn Passive Recall**: Lightweight LLM call before each turn generates targeted questions from recent dialogue -> queries memory backend -> injects top matching memories into context.
  - **Post-Turn Memory Extraction**: Lightweight LLM call after each turn receives last $X$ turns -> extracts noteworthy facts/memories -> writes to memory backend.
  - **Strict Non-Agentic Pipeline**: Narrow single-step tasks: `[Instructions] [Context] -> [Forced JSON output] -> [Run code / store]`. Avoids agentic multi-turn drift.
  - **Core Memories**: Persistent instruction/fact layer injected directly into system prompt; controllable by card/agent to rewire persistent behavior/knowledge.

## 3. Pending Tasks & Open Threads
1. **Apply model updates to documentation**:
   - Update `docs/dd35/future-improvements.md` (FI-10, FI-11, FI-14, FI-17 note).
   - Git commit changes alongside `resume_state.md`.
2. **Design Global Memory Architecture Document**:
   - Synthesize DigUp's robust hybrid ranking & z-score calibration with the queryable backend API/MCP, pre/post turn hooks, and core memories.
   - Address DSH host constraints (CPU without AVX-512 VNNI, asynchronous embedding jobs, clean separation between profile-global memory service and preset-specific consumers).
