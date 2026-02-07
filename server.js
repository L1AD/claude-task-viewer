#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { existsSync, readdirSync, readFileSync, statSync, createReadStream } = require('fs');
const readline = require('readline');
const chokidar = require('chokidar');
const yaml = require('js-yaml');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;

// Parse --dir flag for custom Claude directory
function getClaudeDir() {
  const dirIndex = process.argv.findIndex(arg => arg.startsWith('--dir'));
  if (dirIndex !== -1) {
    const arg = process.argv[dirIndex];
    if (arg.includes('=')) {
      const dir = arg.split('=')[1];
      return dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir;
    } else if (process.argv[dirIndex + 1]) {
      const dir = process.argv[dirIndex + 1];
      return dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir;
    }
  }
  return process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

const CLAUDE_DIR = getClaudeDir();
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Get running Claude Code containers with their project paths
// SSE clients for live updates
const clients = new Set();

// Cache for session metadata (refreshed periodically)
let sessionMetadataCache = {};
let lastMetadataRefresh = 0;
const METADATA_CACHE_TTL = 10000; // 10 seconds

// Parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Read customTitle and slug from a JSONL file
 * Returns { customTitle, slug } - customTitle from /rename, slug from session
 */
function readSessionInfoFromJsonl(jsonlPath) {
  const result = { customTitle: null, slug: null, projectPath: null };

  try {
    if (!existsSync(jsonlPath)) return result;

    // Read first 64KB - should contain custom-title and at least one message with slug/cwd
    const fd = require('fs').openSync(jsonlPath, 'r');
    const buffer = Buffer.alloc(65536);
    const bytesRead = require('fs').readSync(fd, buffer, 0, 65536, 0);
    require('fs').closeSync(fd);

    const content = buffer.toString('utf8', 0, bytesRead);
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

        // Check for custom-title entry (from /rename command)
        if (data.type === 'custom-title' && data.customTitle) {
          result.customTitle = data.customTitle;
        }

        // Check for slug in user/assistant messages
        if (data.slug && !result.slug) {
          result.slug = data.slug;
        }

        // Extract project path from cwd field (actual path, no encoding issues)
        if (data.cwd && !result.projectPath) {
          result.projectPath = data.cwd;
        }

        // Stop early if we found all three
        if (result.customTitle && result.slug && result.projectPath) break;
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (e) {
    // Return partial results
  }

  return result;
}

/**
 * Scan all project directories to find session JSONL files and extract slugs
 */
function loadSessionMetadata() {
  const now = Date.now();
  if (now - lastMetadataRefresh < METADATA_CACHE_TTL) {
    return sessionMetadataCache;
  }

  const metadata = {};

  try {
    if (!existsSync(PROJECTS_DIR)) {
      return metadata;
    }

    const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const projectDir of projectDirs) {
      const projectPath = path.join(PROJECTS_DIR, projectDir.name);

      // Find all .jsonl files (session logs)
      const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const jsonlPath = path.join(projectPath, file);

        // Read customTitle, slug, and actual project path from JSONL
        const sessionInfo = readSessionInfoFromJsonl(jsonlPath);

        metadata[sessionId] = {
          customTitle: sessionInfo.customTitle,
          slug: sessionInfo.slug,
          project: sessionInfo.projectPath || null,
          jsonlPath: jsonlPath
        };
      }

      // Also check sessions-index.json for custom names (if /rename was used)
      const indexPath = path.join(projectPath, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(readFileSync(indexPath, 'utf8'));
          const entries = indexData.entries || [];

          for (const entry of entries) {
            if (entry.sessionId && metadata[entry.sessionId]) {
              // Add other useful fields
              metadata[entry.sessionId].description = entry.description || null;
              metadata[entry.sessionId].gitBranch = entry.gitBranch || null;
              metadata[entry.sessionId].created = entry.created || null;
            }
          }
        } catch (e) {
          // Skip invalid index files
        }
      }
    }
  } catch (e) {
    console.error('Error loading session metadata:', e);
  }

  sessionMetadataCache = metadata;
  lastMetadataRefresh = now;
  return metadata;
}

/**
 * Get display name for a session: customTitle > slug > null (frontend shows UUID)
 */
function getSessionDisplayName(sessionId, meta) {
  if (meta?.customTitle) return meta.customTitle;
  if (meta?.slug) return meta.slug;
  return null; // Frontend will show UUID as fallback
}

// API: List all sessions
app.get('/api/sessions', async (req, res) => {
  // Prevent browser caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    // Parse limit parameter (default: 20, "all" for unlimited)
    const limitParam = req.query.limit || '20';
    const limit = limitParam === 'all' ? null : parseInt(limitParam, 10);

    const metadata = loadSessionMetadata();
    const sessionsMap = new Map();

    // First, add sessions that have tasks directories
    if (existsSync(TASKS_DIR)) {
      const entries = readdirSync(TASKS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionPath = path.join(TASKS_DIR, entry.name);
          const stat = statSync(sessionPath);
          const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));

          // Get task summary and find newest task file
          let completed = 0;
          let inProgress = 0;
          let pending = 0;
          let newestTaskMtime = null;

          for (const file of taskFiles) {
            try {
              const taskPath = path.join(sessionPath, file);
              const task = JSON.parse(readFileSync(taskPath, 'utf8'));
              if (task.status === 'completed') completed++;
              else if (task.status === 'in_progress') inProgress++;
              else pending++;

              // Track newest task file mtime
              const taskStat = statSync(taskPath);
              if (!newestTaskMtime || taskStat.mtime > newestTaskMtime) {
                newestTaskMtime = taskStat.mtime;
              }
            } catch (e) {
              // Skip invalid files
            }
          }

          // Get metadata for this session
          const meta = metadata[entry.name] || {};

          // Use newest task file mtime, or fall back to directory mtime if no tasks
          const modifiedAt = newestTaskMtime ? newestTaskMtime.toISOString() : stat.mtime.toISOString();

          sessionsMap.set(entry.name, {
            id: entry.name,
            name: getSessionDisplayName(entry.name, meta),
            slug: meta.slug || null,
            project: meta.project || null,
            description: meta.description || null,
            gitBranch: meta.gitBranch || null,
            taskCount: taskFiles.length,
            completed,
            inProgress,
            pending,
            createdAt: meta.created || null,
            modifiedAt: modifiedAt
          });
        }
      }
    }

    // Convert map to array and sort by most recently modified
    let sessions = Array.from(sessionsMap.values());
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    // Apply limit if specified
    if (limit !== null && limit > 0) {
      sessions = sessions.slice(0, limit);
    }

    res.json(sessions);
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// API: Get tasks for a session
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const sessionPath = path.join(TASKS_DIR, req.params.sessionId);

    if (!existsSync(sessionPath)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
    const tasks = [];

    for (const file of taskFiles) {
      try {
        const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
        tasks.push(task);
      } catch (e) {
        console.error(`Error parsing ${file}:`, e);
      }
    }

    // Sort by ID (numeric)
    tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));

    res.json(tasks);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// API: Get all tasks across all sessions
app.get('/api/tasks/all', async (req, res) => {
  try {
    if (!existsSync(TASKS_DIR)) {
      return res.json([]);
    }

    const metadata = loadSessionMetadata();
    const sessionDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const allTasks = [];

    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(TASKS_DIR, sessionDir.name);
      const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      const meta = metadata[sessionDir.name] || {};

      for (const file of taskFiles) {
        try {
          const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
          allTasks.push({
            ...task,
            sessionId: sessionDir.name,
            sessionName: getSessionDisplayName(sessionDir.name, meta),
            project: meta.project || null
          });
        } catch (e) {
          // Skip invalid files
        }
      }
    }

    res.json(allTasks);
  } catch (error) {
    console.error('Error getting all tasks:', error);
    res.status(500).json({ error: 'Failed to get all tasks' });
  }
});

// API: Add note to a task
app.post('/api/tasks/:sessionId/:taskId/note', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Note cannot be empty' });
    }

    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Read current task
    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));

    // Append note to description
    const noteBlock = `\n\n---\n\n#### [Note added by user]\n\n${note.trim()}`;
    task.description = (task.description || '') + noteBlock;

    // Write updated task
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    res.json({ success: true, task });
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// API: Delete a task
app.delete('/api/tasks/:sessionId/:taskId', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Check if this task blocks other tasks
    const sessionPath = path.join(TASKS_DIR, sessionId);
    const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));

    for (const file of taskFiles) {
      const otherTask = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
      if (otherTask.blockedBy && otherTask.blockedBy.includes(taskId)) {
        return res.status(400).json({
          error: 'Cannot delete task that blocks other tasks',
          blockedTasks: [otherTask.id]
        });
      }
    }

    // Delete the task file
    await fs.unlink(taskPath);

    res.json({ success: true, taskId });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// API: Get sprint status from a project's sprint-status.yaml
app.get('/api/sprint-status', async (req, res) => {
  try {
    const projectPath = req.query.project;
    if (!projectPath) {
      return res.status(400).json({ error: 'project query parameter required' });
    }

    // Search common locations for sprint-status.yaml
    const candidates = [
      path.join(projectPath, 'docs', 'sprint-artifacts', 'sprint-status.yaml'),
      path.join(projectPath, 'docs', 'sprint-status.yaml'),
      path.join(projectPath, 'sprint-status.yaml'),
    ];

    let sprintFile = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        sprintFile = candidate;
        break;
      }
    }

    if (!sprintFile) {
      return res.status(404).json({ error: 'sprint-status.yaml not found', searched: candidates });
    }

    const content = await fs.readFile(sprintFile, 'utf8');
    const data = yaml.load(content);

    // Parse tasks
    const tasks = data.tasks || {};
    const taskList = Object.entries(tasks).map(([key, val]) => ({
      key,
      status: val.status || 'unknown',
      description: val.description || '',
    }));

    const doneCount = taskList.filter(t => t.status === 'done').length;
    const totalCount = taskList.length;

    // Parse previous sprints
    const previousSprints = [];
    if (data.previous_sprints) {
      for (const [key, val] of Object.entries(data.previous_sprints)) {
        const num = key.match(/sprint_(\d+)/);
        previousSprints.push({
          number: num ? parseInt(num[1]) : 0,
          name: val.name || key,
          status: val.status || 'unknown',
        });
      }
    }
    previousSprints.sort((a, b) => a.number - b.number);

    // Current sprint
    const currentSprint = {
      number: data.current_sprint || null,
      name: data.sprint_name || null,
      goal: data.sprint_goal || null,
      status: data.status || 'unknown',
    };

    // Metrics
    const metrics = data.metrics || {};

    // Carryover items
    const carryover = data.carryover || [];

    res.json({
      currentSprint,
      tasks: taskList,
      metrics: {
        tasksCompleted: metrics.tasks_completed || doneCount,
        tasksTotal: metrics.tasks_total || totalCount,
        testCases: metrics.new_test_cases || 0,
      },
      previousSprints,
      carryover,
      filePath: sprintFile,
    });
  } catch (error) {
    console.error('Error reading sprint status:', error);
    res.status(500).json({ error: 'Failed to read sprint status' });
  }
});

// API: Import tasks into sprint-status.yaml
app.post('/api/sprint-import', async (req, res) => {
  try {
    const { project, sprintNumber, tasks } = req.body;

    if (!project || sprintNumber === undefined || !tasks || !Array.isArray(tasks)) {
      return res.status(400).json({ error: 'project, sprintNumber, and tasks[] required' });
    }

    // Find sprint-status.yaml
    const candidates = [
      path.join(project, 'docs', 'sprint-artifacts', 'sprint-status.yaml'),
      path.join(project, 'docs', 'sprint-status.yaml'),
      path.join(project, 'sprint-status.yaml'),
    ];

    let sprintFile = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        sprintFile = candidate;
        break;
      }
    }

    if (!sprintFile) {
      return res.status(404).json({ error: 'sprint-status.yaml not found' });
    }

    const content = await fs.readFile(sprintFile, 'utf8');
    const data = yaml.load(content);

    // Map task status to sprint status
    const statusMap = {
      'pending': 'backlog',
      'in_progress': 'in-progress',
      'completed': 'done',
    };

    // Ensure tasks map exists
    if (!data.tasks) {
      data.tasks = {};
    }

    const imported = [];
    for (const task of tasks) {
      const storyKey = task.storyKey || `sprint-${sprintNumber}-${task.subject
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 50)}`;

      // Skip if key already exists
      if (data.tasks[storyKey]) {
        continue;
      }

      const sprintStatus = statusMap[task.status] || 'backlog';
      data.tasks[storyKey] = {
        status: sprintStatus,
        description: task.description || task.subject,
        source: 'product-pulse',
      };
      imported.push({ storyKey, status: sprintStatus, subject: task.subject });
    }

    // Update metrics
    if (!data.metrics) data.metrics = {};
    data.metrics.tasks_total = (data.metrics.tasks_total || 0) + imported.length;

    // Update sprint number if needed
    if (sprintNumber > (data.current_sprint || 0)) {
      data.current_sprint = sprintNumber;
    }

    // Write back
    await fs.writeFile(sprintFile, yaml.dump(data, { lineWidth: -1 }));

    res.json({ success: true, imported, filePath: sprintFile });
  } catch (error) {
    console.error('Error importing to sprint:', error);
    res.status(500).json({ error: 'Failed to import to sprint' });
  }
});

// API: Set task priority
app.post('/api/tasks/:sessionId/:taskId/priority', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { priority } = req.body;

    if (!priority || !['P1', 'P2', 'P3'].includes(priority)) {
      return res.status(400).json({ error: 'priority must be P1, P2, or P3' });
    }

    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));

    // Update metadata with priority
    if (!task.metadata) task.metadata = {};
    task.metadata.priority = priority;

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    res.json({ success: true, task });
  } catch (error) {
    console.error('Error setting priority:', error);
    res.status(500).json({ error: 'Failed to set priority' });
  }
});

// SSE endpoint for live updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
});

// Broadcast update to all SSE clients
function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

// Watch for file changes (chokidar handles non-existent paths)
const watcher = chokidar.watch(TASKS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2
});

watcher.on('all', (event, filePath) => {
  if (filePath.endsWith('.json')) {
    const relativePath = path.relative(TASKS_DIR, filePath);
    const sessionId = relativePath.split(path.sep)[0];

    broadcast({
      type: 'update',
      event,
      sessionId,
      file: path.basename(filePath)
    });
  }
});

console.log(`Watching for changes in: ${TASKS_DIR}`);

// Also watch projects dir for metadata changes
const projectsWatcher = chokidar.watch(PROJECTS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2
});

projectsWatcher.on('all', (event, filePath) => {
  if (filePath.endsWith('.jsonl')) {
    // Invalidate cache on any change
    lastMetadataRefresh = 0;
    broadcast({ type: 'metadata-update' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Claude Task Viewer running at http://localhost:${PORT}`);

  // Open browser if --open flag is passed
  if (process.argv.includes('--open')) {
    import('open').then(open => open.default(`http://localhost:${PORT}`));
  }
});
