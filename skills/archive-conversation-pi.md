---
name: archive-conversation
description: Request archival of this Pi conversation. Use only when the user explicitly asks to archive the conversation.
---

Run exactly this command once:

```bash
bash /home/agent/.local/bin/agent-archive-request.sh request pi "$PI_SESSION_ID" "$PWD" "$PI_SESSION_ID"
```

Report the request ID. Do not claim the conversation was uploaded: the host
collector will validate and process the request asynchronously when this turn
finishes.
