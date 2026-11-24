export const roles = [
  {
    id: 'requirements',
    tier: 'fast',
    needs: [],
    focus: 'Extract numbered functional requirements and quality requirements with observable acceptance conditions. Separate the supplied requirements, provider assumptions and your proposed operating targets. Classify each behavior as implemented, proposed or open based on evidence.'
  },
  {
    id: 'architecture',
    tier: 'reasoning',
    needs: ['requirements'],
    focus: 'Design the backend boundary and execution model. Walk through the example with durable transaction boundaries. Explain why this degree of extensibility fits a small team, name one credible alternative and the condition that would justify switching. Supply a UML 2 component diagram of the service boundary and a UML 2 sequence diagram of successful delivery. Label dependencies, participants, calls and transaction boundaries.'
  },
  {
    id: 'data',
    tier: 'reasoning',
    needs: ['requirements'],
    focus: 'Specify grains, natural and surrogate keys, tenant boundaries, unique constraints, version pinning, sensitive fields and retention. Trace a qualified reply to the analytical fact. Explain late events and replay. Reference actual schema names where available. Supply a UML 2 class diagram of the relational model with association-end multiplicities and key fields.'
  },
  {
    id: 'reliability',
    tier: 'reasoning',
    needs: ['requirements'],
    focus: 'Consider duplicates, cross-tenant collisions, competing runs for one commenter, early replies, process crashes, an expired worker lease, rate limits and uncertain provider acceptance. For each material case describe the invariant, recovery action, and evidence or unresolved risk. Supply a UML 2 state machine showing the guards and events that govern recovery.'
  },
  {
    id: 'draft',
    tier: 'reasoning',
    needs: ['requirements', 'architecture', 'data', 'reliability'],
    focus: 'Write the complete standalone engineering design for this product. Reconcile choices against the repository. Include the worked example, a short rationale, FR/NFR table, named diagrams, data engineering, failure and concurrency behavior, and what the tests establish. A reviewer should be able to understand the design without reading a handoff.'
  },
  {
    id: 'technical-review',
    tier: 'reasoning',
    needs: ['draft'],
    focus: 'Review the draft as a service owner. Walk a specific comment through success, replay, restart and ambiguous delivery. Check claims, test names, SQL constraints, UML 2 associations, multiplicities, message order and guarded state transitions against source. Give actionable corrections with evidence and identify open assumptions. Treat test definitions and recorded execution results separately.'
  },
  {
    id: 'english-review',
    tier: 'fast',
    needs: ['draft'],
    focus: 'Apply the English adaptation of humanizer-ru. Read the draft before suggesting edits. Quote only the passages that need editing. Replace filler, vague agents and inflated certainty with concrete actors and effects. Preserve engineering terms and quoted product copy. Give replacement wording where it helps an English-speaking reviewer.'
  },
  {
    id: 'design',
    tier: 'reasoning',
    needs: ['draft', 'technical-review', 'english-review'],
    focus: 'Return the complete design in Markdown. Resolve review findings against evidence. Preserve supported facts, IDs and diagram semantics in the English edit. Include four UML 2 views as fenced PlantUML source. Use a component diagram for service dependencies, a sequence diagram for message order, a state machine for execution and recovery, and a class diagram with association-end multiplicities for stored data. Describe failure semantics, data engineering, acceptance evidence and outstanding risks. Write for the engineer responsible for operating this service. Keep commentary about this editing process out of the document.'
  }
];
