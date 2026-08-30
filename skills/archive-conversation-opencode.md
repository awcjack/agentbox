---
description: Request archival of this conversation through this explicit request. Run only when invoked by the user.
---

Run exactly this command once:

```bash
bash /home/agent/.local/bin/agent-archive-request.sh request opencode
```

Report the request ID. Do not claim the webhook accepted the conversation: the
host delivery service will validate and process the request asynchronously.
