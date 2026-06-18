# Dev Log

Running log of decisions, changes, and context for the SysDes project.

---

## 2026-06-19

### Project initialized
- Created repo: https://github.com/duclong565/sydes.git
- Planning doc: `system-design-sandbox.md`
- Added `CLAUDE.md` with architecture overview

### Brainstorming session — Graph Compiler design
**Decisions locked:**
- Primary user: senior engineer / tech lead (free-form architecture building, not guided learning)
- Image strategy: pre-built `sds/*` images for MVP, bring-your-own Docker image in Phase 2
- MVP goal: Graph Compiler working reliably end-to-end before building real-time metrics UI
- Phase 1 node types: Service, Kafka, Worker, DB, LB (5 types)
- Error handling: fail loudly — compiler refuses to generate and reports clear errors; no best-effort output

**Under discussion:**
- Graph Compiler internal architecture (node-owned handlers vs. flat rule table vs. two-phase pipeline)
