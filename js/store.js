/**
 * Estado, Datos y Bitácora de Movimientos (V3 - EN LÍNEA)
 * ----------------------------------------------------------------
 * Diferencia con V2: las tareas y el historial ya NO se guardan en el
 * navegador (localStorage), sino en Firebase Firestore. Así todos los
 * usuarios ven y editan la misma información desde cualquier computador.
 *
 * - Colección "planner_tasks": una ficha por tarea.
 * - Colección "planner_log":   un registro por movimiento del Historial.
 * - Cada movimiento guarda además quién lo hizo (campo "by" = correo).
 *
 * La "API" del Store (getTasks, saveTask, deleteTask, etc.) es la misma
 * de V2, por eso app.js casi no cambia.
 */
const COLLECTIONS = { tasks: 'planner_tasks', log: 'planner_log' };

// Cargos / responsables (igual que V2). Para agregar uno, añádelo aquí.
const INITIAL_USERS = [
  { id: "usr-1", name: "Finanzas", role: "FIN" },
  { id: "usr-2", name: "Contabilidad", role: "CONT" },
  { id: "usr-3", name: "Administrativo", role: "ADM" },
  { id: "usr-4", name: "Secretaria Gerencia", role: "SEC" },
  { id: "usr-5", name: "Compras", role: "COMP" }
];

/* ---------- Utilidades globales (también las usa app.js) ---------- */
function formatDuration(ms) {
  if (!ms || ms <= 0) return "0m";
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || (days === 0 && hours === 0)) parts.push(`${minutes}m`);
  if (days === 0 && hours === 0 && minutes < 5) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatDateCL(isoDate) {
  if (!isoDate) return "-";
  const [y, m, d] = String(isoDate).split('-');
  return `${d}-${m}-${y}`;
}

function setSyncStatus(text, cls) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}

class Store {
  constructor(db) {
    this.db = db;
    this.users = INITIAL_USERS;
    this.tasks = [];
    this.log = [];
    this.currentUser = "";       // correo de quien está conectado
    this.onChange = null;        // app.js lo asigna: redibuja la vista
    this.pending = [];           // cambios por enviar a Firestore
  }

  /* ---------- SINCRONIZACIÓN CON FIRESTORE ---------- */

  /** Escucha las dos colecciones. Llama a onFirstLoad cuando ambas llegaron por primera vez. */
  subscribe(onFirstLoad) {
    let gotTasks = false, gotLog = false, fired = false;
    const check = () => {
      if (gotTasks && gotLog) {
        if (!fired) { fired = true; onFirstLoad(); }
        else if (typeof this.onChange === 'function') this.onChange();
      }
    };
    const onError = (err) => {
      console.error(err);
      if (err.code === 'permission-denied') {
        setSyncStatus('Sin permiso: tu correo no está autorizado', 'err');
        alert('Tu correo no está autorizado para ver el planificador.\nPide al administrador que lo agregue a las Reglas de Firestore.');
      } else {
        setSyncStatus('Error de conexión con la base', 'err');
      }
    };

    this.unsubTasks = this.db.collection(COLLECTIONS.tasks).onSnapshot(snap => {
      this.tasks = snap.docs.map(d => d.data())
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
      gotTasks = true;
      this.updateStatusFromSnap(snap);
      check();
    }, onError);

    this.unsubLog = this.db.collection(COLLECTIONS.log).onSnapshot(snap => {
      this.log = snap.docs.map(d => d.data()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      gotLog = true;
      check();
    }, onError);
  }

  updateStatusFromSnap(snap) {
    const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
    if (snap.metadata.hasPendingWrites) setSyncStatus('Guardando…');
    else setSyncStatus(`✔ Sincronizado ${hora}`, 'ok');
  }

  queuePut(col, obj) { this.pending.push({ type: 'set', col, id: obj.id, data: obj }); }
  queueDel(col, id) { this.pending.push({ type: 'del', col, id }); }

  /** Envía a Firestore todos los cambios acumulados (en lotes de hasta 450). */
  save() {
    const ops = this.pending;
    this.pending = [];
    if (!ops.length) return;
    setSyncStatus('Guardando…');

    for (let i = 0; i < ops.length; i += 450) {
      const batch = this.db.batch();
      ops.slice(i, i + 450).forEach(op => {
        const ref = this.db.collection(op.col).doc(op.id);
        if (op.type === 'set') batch.set(ref, JSON.parse(JSON.stringify(op.data)));
        else batch.delete(ref);
      });
      batch.commit().catch(err => {
        console.error('No se pudo guardar', err);
        setSyncStatus('⚠ No se guardó el último cambio', 'err');
        alert('No se pudo guardar el cambio en la base compartida.\n' +
          (err.code === 'permission-denied' ? 'Tu correo no tiene permiso de escritura.' : 'Revisa tu conexión a internet y vuelve a intentarlo.'));
      });
    }
  }

  /* ---------- BITÁCORA ---------- */
  newLogId() {
    return 'log-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
  }

  addLog(entry) {
    const rec = {
      id: this.newLogId(),
      ts: Date.now(),
      migrated: false,
      fromStatus: null,
      toStatus: null,
      detail: "",
      by: this.currentUser,
      ...entry
    };
    this.log.push(rec);
    this.queuePut(COLLECTIONS.log, rec);
  }

  getLog() {
    return this.log;
  }

  /* ---------- TAREAS ---------- */
  getTasks(filters = {}) {
    return this.tasks.filter(t => {
      if (filters.periodStart && t.endDate < filters.periodStart) return false;
      if (filters.periodEnd && t.startDate > filters.periodEnd) return false;

      if (filters.assigneeId && filters.assigneeId !== 'ALL' && t.assigneeId !== filters.assigneeId) return false;
      if (filters.priority && filters.priority !== 'ALL' && t.priority !== filters.priority) return false;
      if (filters.frequency && filters.frequency !== 'ALL' && t.frequency !== filters.frequency) return false;
      if (filters.status && filters.status !== 'ALL' && t.status !== filters.status) return false;
      if (filters.dateFrom && t.startDate < filters.dateFrom) return false;
      if (filters.dateTo && t.endDate > filters.dateTo) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!t.title.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  /**
   * Guarda una tarea nueva o actualiza una existente.
   * - Controla el cronómetro (pausa/reanuda) cuando cambia el estado.
   * - Registra el movimiento en la bitácora.
   * opts.source = 'Importación' para tareas cargadas desde Excel.
   */
  saveTask(taskData, opts = {}) {
    const now = Date.now();

    if (taskData.id) {
      const idx = this.tasks.findIndex(t => t.id === taskData.id);
      if (idx === -1) return null;

      const prev = { ...this.tasks[idx] };
      const incoming = { ...taskData };
      delete incoming.inProgressStart;
      delete incoming.totalProcessTime;
      const next = { ...prev, ...incoming };

      if (prev.status !== next.status) {
        if (prev.status === 'En proceso' && prev.inProgressStart) {
          next.totalProcessTime = (prev.totalProcessTime || 0) + (now - prev.inProgressStart);
          next.inProgressStart = null;
        }
        if (next.status === 'En proceso') {
          next.inProgressStart = now;
        }
      }

      next.updatedAt = now;
      next.updatedBy = this.currentUser;
      this.tasks[idx] = next;
      this.queuePut(COLLECTIONS.tasks, next);
      const userName = this.getUserById(next.assigneeId).name;

      if (prev.status !== next.status) {
        let detail = "";
        if (next.status === 'Completada') detail = `Tiempo registrado: ${formatDuration(next.totalProcessTime || 0)}`;
        else if (prev.status === 'En proceso') detail = `Tiempo acumulado: ${formatDuration(next.totalProcessTime || 0)}`;
        this.addLog({
          action: 'Cambio de estado', taskId: next.id, taskTitle: next.title,
          assigneeId: next.assigneeId, assigneeName: userName,
          fromStatus: prev.status, toStatus: next.status, detail
        });
      }

      const fields = [
        ['title', 'Nombre', v => v],
        ['assigneeId', 'Responsable', v => this.getUserById(v).name],
        ['frequency', 'Frecuencia', v => v],
        ['priority', 'Prioridad', v => v],
        ['startDate', 'Inicio', v => formatDateCL(v)],
        ['endDate', 'Término', v => formatDateCL(v)]
      ];
      const changes = [];
      fields.forEach(([key, label, fmt]) => {
        if (prev[key] !== next[key]) changes.push(`${label}: ${fmt(prev[key])} → ${fmt(next[key])}`);
      });
      if (changes.length) {
        this.addLog({
          action: 'Edición', taskId: next.id, taskTitle: next.title,
          assigneeId: next.assigneeId, assigneeName: userName,
          detail: changes.join(' · ')
        });
      }

      this.save();
      return next.id;
    }

    // Tarea nueva
    const newId = 'task-' + Date.now() + Math.floor(Math.random() * 1000);
    const status = taskData.status || 'Pendiente';
    const newTask = {
      ...taskData,
      id: newId,
      status,
      inProgressStart: status === 'En proceso' ? now : null,
      totalProcessTime: 0,
      createdAt: now,
      createdBy: this.currentUser
    };
    this.tasks.push(newTask);
    this.queuePut(COLLECTIONS.tasks, newTask);

    this.addLog({
      action: opts.source === 'Importación' ? 'Importación' : 'Creación',
      taskId: newId, taskTitle: newTask.title,
      assigneeId: newTask.assigneeId, assigneeName: this.getUserById(newTask.assigneeId).name,
      fromStatus: null, toStatus: status,
      detail: `Plazo: ${formatDateCL(newTask.startDate)} al ${formatDateCL(newTask.endDate)} · Prioridad: ${newTask.priority} · Frecuencia: ${newTask.frequency}`
    });

    this.save();
    return newId;
  }

  /**
   * Elimina una tarea.
   * opts.purgeLog = true  -> borra también sus registros del Historial
   * opts.purgeLog = false -> la elimina dejando constancia ("Eliminación") en el Historial
   */
  deleteTask(id, opts = {}) {
    this.removeTaskInternal(id, opts.purgeLog !== false);
    this.save();
  }

  deleteTasks(ids, opts = {}) {
    const purge = opts.purgeLog !== false;
    let count = 0;
    ids.forEach(id => { if (this.removeTaskInternal(id, purge)) count++; });
    this.save();
    return count;
  }

  purgeDeletedTasksFromLog() {
    const existing = new Set(this.tasks.map(t => t.id));
    const orphans = this.log.filter(l => !existing.has(l.taskId));
    orphans.forEach(l => this.queueDel(COLLECTIONS.log, l.id));
    this.log = this.log.filter(l => existing.has(l.taskId));
    this.save();
    return orphans.length;
  }

  countOrphanLogs() {
    const existing = new Set(this.tasks.map(t => t.id));
    return this.log.filter(l => !existing.has(l.taskId)).length;
  }

  removeTaskInternal(id, purgeLog) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    if (purgeLog) {
      this.log.filter(l => l.taskId === id).forEach(l => this.queueDel(COLLECTIONS.log, l.id));
      this.log = this.log.filter(l => l.taskId !== id);
    } else {
      this.addLog({
        action: 'Eliminación', taskId: task.id, taskTitle: task.title,
        assigneeId: task.assigneeId, assigneeName: this.getUserById(task.assigneeId).name,
        fromStatus: task.status, toStatus: null,
        detail: `Plazo: ${formatDateCL(task.startDate)} al ${formatDateCL(task.endDate)} · Prioridad: ${task.priority} · Tiempo registrado: ${formatDuration(task.totalProcessTime || 0)}`
      });
    }
    this.tasks = this.tasks.filter(t => t.id !== id);
    this.queueDel(COLLECTIONS.tasks, id);
    return true;
  }

  getUserById(id) {
    return this.users.find(u => u.id === id) || { name: "Sin Asignar", role: "N/A" };
  }
}

/* =========================================================
   ARRANQUE: conexión a Firebase + inicio de sesión
   ========================================================= */
(function boot() {
  const loginScreen = document.getElementById('login-screen');
  const form = document.getElementById('login-form');
  const msg = document.getElementById('login-msg');
  const btn = document.getElementById('login-btn');

  if (typeof firebase === 'undefined') {
    msg.textContent = 'No se pudo cargar Firebase. Revisa tu conexión a internet.';
    return;
  }
  if (typeof firebaseConfig === 'undefined' || String(firebaseConfig.apiKey).includes('PEGAR')) {
    msg.textContent = 'Falta configurar Firebase: completa el archivo js/firebase-config.js.';
    btn.disabled = true;
    return;
  }

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const store = new Store(db);
  window.appStore = store;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Ingresando…';
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    auth.signInWithEmailAndPassword(email, pass).catch(err => {
      const map = {
        'auth/invalid-credential': 'Correo o contraseña incorrectos.',
        'auth/wrong-password': 'Correo o contraseña incorrectos.',
        'auth/user-not-found': 'Correo o contraseña incorrectos.',
        'auth/invalid-email': 'El correo no tiene un formato válido.',
        'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
        'auth/network-request-failed': 'Sin conexión a internet.'
      };
      msg.textContent = map[err.code] || ('No se pudo ingresar (' + err.code + ').');
      btn.disabled = false;
      btn.textContent = 'Ingresar';
    });
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    auth.signOut().then(() => location.reload());
  });

  let started = false;
  auth.onAuthStateChanged(user => {
    if (!user) {
      loginScreen.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Ingresar';
      return;
    }
    store.currentUser = (user.email || '').toLowerCase();
    document.getElementById('session-user').textContent = store.currentUser;
    loginScreen.classList.add('hidden');
    if (started) return;
    started = true;
    store.subscribe(() => window.startPlannerApp());
  });
})();
