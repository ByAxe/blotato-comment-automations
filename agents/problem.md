# Comment-triggered automations

A creator wants to start a conversation when someone comments on one of their social posts. For a connected Instagram account, the first workflow applies to any post. When someone comments “pricing”, the automation takes the following steps in order.

1. Reply to the comment with “Sent you a DM!”
2. Send the commenter a direct message asking for their email address.
3. Wait for the commenter to respond.
4. Once the commenter sends an email address, send them a direct message containing a link.

Use the [current product requirements](../docs/requirements.md) in the supplied source snapshot for optional capabilities such as post targeting and participant context.

The existing social integration receives comments and messages, replies to a comment, and sends a message. The automation service owns workflow definitions, durable execution and recovery. Define the architecture, data model, concurrency rules and execution semantics. Explain which workflows this model can express, and when the design would need to change.

Use English. Identify functional and nonfunctional requirements, trace data from an incoming event to a report, and use UML 2 for all architecture diagrams. Provide component, sequence, state machine and class views as PlantUML source.
