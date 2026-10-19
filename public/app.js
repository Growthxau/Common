const form = document.querySelector('#task-form');
const input = document.querySelector('#task-input');
const taskList = document.querySelector('#task-list');
const taskCount = document.querySelector('#task-count');
const emptyState = document.querySelector('#empty-state');
const statusMessage = document.querySelector('#status-message');
const filterButtons = [...document.querySelectorAll('.filter-button')];

let tasks = [];
let activeFilter = 'all';

function showError(message) {
  statusMessage.textContent = message;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Something went wrong. Please try again.');
  }
  return response.status === 204 ? null : response.json();
}

function renderTasks() {
  const visibleTasks = tasks.filter((task) => {
    if (activeFilter === 'open') return !task.completed;
    if (activeFilter === 'done') return task.completed;
    return true;
  });

  taskList.replaceChildren(...visibleTasks.map((task) => {
    const item = document.createElement('li');
    item.className = `task-item${task.completed ? ' is-complete' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.className = 'task-check';
    checkbox.type = 'checkbox';
    checkbox.checked = task.completed;
    checkbox.setAttribute('aria-label', `Mark ${task.text} ${task.completed ? 'incomplete' : 'complete'}`);
    checkbox.addEventListener('change', () => updateTask(task.id, checkbox.checked));

    const text = document.createElement('span');
    text.className = 'task-text';
    text.textContent = task.text;

    const removeButton = document.createElement('button');
    removeButton.className = 'delete-button';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.setAttribute('aria-label', `Delete ${task.text}`);
    removeButton.title = 'Delete task';
    removeButton.addEventListener('click', () => deleteTask(task.id));

    item.append(checkbox, text, removeButton);
    return item;
  }));

  taskCount.textContent = tasks.length;
  emptyState.hidden = visibleTasks.length > 0;
  if (tasks.length === 0) {
    emptyState.textContent = 'A clear page. Add one small thing to begin.';
  } else if (visibleTasks.length === 0) {
    emptyState.textContent = activeFilter === 'open' ? 'All caught up. Enjoy the breathing room.' : 'Nothing checked off just yet.';
  }
}

async function updateTask(id, completed) {
  statusMessage.textContent = '';
  try {
    const updatedTask = await request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed }),
    });
    tasks = tasks.map((task) => task.id === id ? updatedTask : task);
    renderTasks();
  } catch (error) {
    showError(error.message);
    loadTasks();
  }
}

async function deleteTask(id) {
  statusMessage.textContent = '';
  try {
    await request(`/api/tasks/${id}`, { method: 'DELETE' });
    tasks = tasks.filter((task) => task.id !== id);
    renderTasks();
  } catch (error) {
    showError(error.message);
  }
}

async function loadTasks() {
  try {
    tasks = await request('/api/tasks');
    renderTasks();
  } catch (error) {
    showError(error.message);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  statusMessage.textContent = '';
  try {
    const task = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    tasks.unshift(task);
    input.value = '';
    activeFilter = 'all';
    filterButtons.forEach((button) => {
      const isActive = button.dataset.filter === activeFilter;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    renderTasks();
    input.focus();
  } catch (error) {
    showError(error.message);
  }
});

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle('is-active', isActive);
      item.setAttribute('aria-selected', String(isActive));
    });
    renderTasks();
  });
});

const todayLabel = document.querySelector('#today-label');
todayLabel.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
loadTasks();