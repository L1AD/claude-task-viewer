#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { existsSync, readdirSync, readFileSync, statSync, createReadStream } = require('fs');
const readline = require('readline');
const chokidar = require('chokidar');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// SSE clients for live updates
const clients = new Set();

// Cache for session metadata (refreshed periodically)
let sessionMetadataCache = {};
let lastMetadataRefresh = 0;
const METADATA_CACHE_TTL = 10000; // 10 seconds

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Read customTitle and slug from a JSONL file
 * Returns { customTitle, slug } - customTitle from /rename, slug from session
 */
function readSessionInfoFromJsonl(jsonlPath) {
  const result = { customTitle: null, slug: null };

  try {
    if (!existsSync(jsonlPath)) return result;

    // Read first 64KB - should contain custom-title and at least one message with slug
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

        // Stop early if we found both
        if (result.customTitle && result.slug) break;
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

        // Read customTitle and slug from JSONL
        const sessionInfo = readSessionInfoFromJsonl(jsonlPath);

        // Decode project path from folder name (replace - with /)
        const projectName = projectDir.name.replace(/^-/, '').replace(/-/g, '/');

        metadata[sessionId] = {
          customTitle: sessionInfo.customTitle,
          slug: sessionInfo.slug,
          project: '/' + projectName,
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
              // Check for custom name field (might be 'customName', 'name', or similar)
              if (entry.customName) {
                metadata[entry.sessionId].customName = entry.customName;
              }
              if (entry.name) {
                metadata[entry.sessionId].customName = entry.name;
              }
              // Add other useful fields
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
  try {
    if (!existsSync(TASKS_DIR)) {
      return res.json([]);
    }

    const metadata = loadSessionMetadata();
    const entries = readdirSync(TASKS_DIR, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionPath = path.join(TASKS_DIR, entry.name);
        const stat = statSync(sessionPath);
        const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));

        // Get task summary
        let completed = 0;
        let inProgress = 0;
        let pending = 0;

        for (const file of taskFiles) {
          try {
            const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
            if (task.status === 'completed') completed++;
            else if (task.status === 'in_progress') inProgress++;
            else pending++;
          } catch (e) {
            // Skip invalid files
          }
        }

        // Get metadata for this session
        const meta = metadata[entry.name] || {};

        sessions.push({
          id: entry.name,
          name: getSessionDisplayName(entry.name, meta),
          slug: meta.slug || null,
          project: meta.project || null,
          gitBranch: meta.gitBranch || null,
          taskCount: taskFiles.length,
          completed,
          inProgress,
          pending,
          createdAt: meta.created || null,
          modifiedAt: stat.mtime.toISOString()
        });
      }
    }

    // Sort by most recently modified
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

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

// Watch for file changes
if (existsSync(TASKS_DIR)) {
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
}

// Also watch projects dir for metadata changes
if (existsSync(PROJECTS_DIR)) {
  const projectsWatcher = chokidar.watch(path.join(PROJECTS_DIR, '*/*.jsonl'), {
    persistent: true,
    ignoreInitial: true,
    depth: 1
  });

  projectsWatcher.on('all', (event) => {
    // Invalidate cache on any change
    lastMetadataRefresh = 0;
    broadcast({ type: 'metadata-update' });
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`Claude Task Viewer running at http://localhost:${PORT}`);

  // Open browser if --open flag is passed
  if (process.argv.includes('--open')) {
    import('open').then(open => open.default(`http://localhost:${PORT}`));
  }
});
