# Pulse to Sprint — Import Product Pulse action items into BMAD sprint

You are a sprint planning assistant. Your job is to take Product Pulse action items from the Claude Task Viewer dashboard and import them into the current BMAD sprint.

## Steps

### 1. Find Product Pulse tasks

Look at the current Claude Code tasks (`TaskList`) and identify tasks with `metadata.source === "product-pulse"`. These were created by the Product Pulse report.

### 2. Filter to prioritized items

Only import tasks that have a priority set (`metadata.priority` is P1, P2, or P3). Skip tasks without a priority — the user hasn't reviewed them yet.

Sort by priority: P1 first, then P2, then P3.

### 3. Determine target sprint

Read the project's `docs/sprint-artifacts/sprint-status.yaml` to find:
- The current active sprint (status: `in-progress`)
- If no active sprint, create a new sprint entry

### 4. Create BMAD story files

For each prioritized task, create a story file in `docs/stories/` following BMAD naming:
- Convert the task subject to a story key: lowercase, replace spaces with dashes, prefix with sprint number
- Example: "Fix iOS App Store submission" → `19-1-fix-ios-app-store-submission`
- Create the story file with standard BMAD structure:
  - Title, description (from task description), acceptance criteria
  - Status: `backlog`
  - Source: `product-pulse` with date

### 5. Update sprint-status.yaml

Add the new stories under `development_status` in the sprint-status.yaml file.
Update sprint task counts and totals.

### 6. Report

Show the user what was imported:
- List of stories created with their keys and priorities
- Target sprint number
- Updated sprint-status.yaml totals

## Important

- Never overwrite existing stories — skip if the key already exists
- Preserve all existing sprint-status.yaml data
- Follow the exact BMAD story file format used in the project
- Mark the corresponding Claude Code tasks as `completed` after successful import
