const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const port = Number(process.env.PORT) || 3000;
const dataPath = path.join(__dirname, 'tasks.json');
const publicPath = path.join(__dirname, 'public');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

let tasks = [];
try {
  tasks = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function saveTasks() {
  fs.writeFileSync(dataPath, `${JSON.stringify(tasks, null, 2)}\n`);
}

async function handleApi(request, response, pathname) {
  if (pathname === '/api/tasks' && request.method === 'GET') {
    return sendJson(response, 200, tasks);
  }

  if (pathname === '/api/tasks' && request.method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 200) {
      return sendJson(response, 400, { error: 'Task text must be between 1 and 200 characters.' });
    }
    const task = { id: randomUUID(), text, completed: false, createdAt: new Date().toISOString() };
    tasks.unshift(task);
    saveTasks();
    return sendJson(response, 201, task);
  }

  const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskRoute) {
    const task = tasks.find((item) => item.id === taskRoute[1]);
    if (!task) return sendJson(response, 404, { error: 'Task not found.' });

    if (request.method === 'PATCH') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
      if (typeof body.completed !== 'boolean') {
        return sendJson(response, 400, { error: 'Completed must be true or false.' });
      }
      task.completed = body.completed;
      saveTasks();
      return sendJson(response, 200, task);
    }

    if (request.method === 'DELETE') {
      tasks = tasks.filter((item) => item.id !== task.id);
      saveTasks();
      response.writeHead(204);
      return response.end();
    }
  }

  return sendJson(response, 404, { error: 'Not found.' });
}

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (pathname.startsWith('/api/')) {
    return handleApi(request, response, pathname);
  }

  const fileName = pathname === '/' ? 'index.html' : path.basename(pathname);
  const filePath = path.join(publicPath, fileName);
  if (!contentTypes[path.extname(filePath)]) {
    response.writeHead(404);
    return response.end('Not found');
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      return response.end('Not found');
    }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] });
    response.end(content);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Daybook is running at http://localhost:${port}`);
});