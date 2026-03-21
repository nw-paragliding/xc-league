# Backlog

## QR codes for large tasks

Large tasks (many turnpoints, long waypoint names) may produce QR codes that are too dense to scan reliably with phones. Investigate:

- What's the current byte limit before QR density becomes a problem?
- Can we reduce the XCTSK payload size (shorter field names, fewer decimals)?
- Fallback options: chunked QR codes, download-only flow, deep-link URL instead of embedded data?

Related files: `src/task-exporters.ts`, `frontend/src/components/TaskExportModal.tsx`
