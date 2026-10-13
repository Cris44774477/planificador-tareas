/**
 * Controlador Principal - Lógica e Interacción (V4 - 13-10-2026)
 * - V4: cargos editables (ventana "Administrar cargos") y vista para celular
 * - Periodo (mes) único para Gantt, Kanban, Tabla, Métricas y Reporte Mensual
 * - Historial de Gestión como bitácora de movimientos filtrable por mes/año
 * - Botones Editar / Borrar en la Carta Gantt
 * - Modo oscuro
 */
window.startPlannerApp = () => {
  const store = window.appStore;
  const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const STATUSES = ["Pendiente", "En proceso", "Completada", "Suspendida"];

  let stateFilters = { assigneeId: 'ALL', priority: 'ALL', frequency: 'ALL', dateFrom: '', dateTo: '', search: '' };

  // Mes visible compartido por todos los módulos (siempre día 1 para evitar saltos de mes)
  let periodDate = firstDayOfMonth(new Date());

  let ganttCellWidthClass = "zoom-normal";
  let highlightTodayColumn = false;

  let historyFilters = { month: 'ALL', year: 'ALL', action: 'ALL' };
  let lastHistoryRows = [];

  let statusDoughnutChart = null;
  let reportWorkloadChart = null;
  let timerInterval = null;

  /* =========================================================
     HELPERS
     ========================================================= */
  function pad(n) { return String(n).padStart(2, "0"); }
  function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function toLocalISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayISO() { return toLocalISO(new Date()); }
  function parseLocalDate(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
  function fmtShort(s) { const [, m, d] = String(s).split("-"); return `${d}/${m}`; }
  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function periodRange() {
    const y = periodDate.getFullYear(), m = periodDate.getMonth();
    return { start: toLocalISO(new Date(y, m, 1)), end: toLocalISO(new Date(y, m + 1, 0)) };
  }
  function periodLabel() { return `${MONTHS[periodDate.getMonth()]} ${periodDate.getFullYear()}`; }
  function getPeriodTasks() {
    const r = periodRange();
    return store.getTasks({ ...stateFilters, periodStart: r.start, periodEnd: r.end });
  }
  function statusKey(st) {
    if (st === "Completada") return "completada";
    if (st === "En proceso") return "en-proceso";
    if (st === "Suspendida") return "suspendida";
    return "pendiente";
  }
  function statusBadge(st) {
    if (!st) return "";
    return `<span class="status-badge bg-${statusKey(st)}">${escapeHtml(st)}</span>`;
  }
  function priorityBadge(p) {
    const cls = p === "Crítica" ? "badge-critical" : p === "Media" ? "badge-media" : "badge-baja";
    return `<span class="badge-tag ${cls}">${escapeHtml(p)}</span>`;
  }
  function elapsedOf(t) {
    return (t.totalProcessTime || 0) + (t.status === "En proceso" && t.inProgressStart ? Date.now() - t.inProgressStart : 0);
  }
  function isOverdue(t) {
    return t.endDate < todayISO() && t.status !== "Completada" && t.status !== "Suspendida";
  }
  function daysLate(t) {
    const diff = parseLocalDate(todayISO()) - parseLocalDate(t.endDate);
    return Math.max(0, Math.round(diff / 86400000));
  }
  /**
   * V4: cargos a mostrar en filtros, métricas y reporte:
   * todos los activos + los inactivos que todavía tienen tareas en el periodo.
   */
  function cargosForTasks(tasks) {
    const withTasks = new Set(tasks.map(t => t.assigneeId));
    return store.users.filter(u => u.active !== false || withTasks.has(u.id));
  }
  function cargoLabel(u) {
    return u.active === false ? `${u.name} (inactivo)` : u.name;
  }
  function isMobile() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function normalizeOption(value, options, fallback) {
    if (value === null || value === undefined) return fallback;
    const v = String(value).trim().toLowerCase();
    const found = options.find(o => o.toLowerCase() === v);
    return found || fallback;
  }

  /* =========================================================
     MODO OSCURO
     ========================================================= */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }
  function applyChartTheme() {
    if (typeof Chart === "undefined") return;
    const dark = currentTheme() === "dark";
    Chart.defaults.color = dark ? "#cbd5e1" : "#475569";
    Chart.defaults.borderColor = dark ? "#26324a" : "#e2e8f0";
  }
  function applyTheme(theme, persist) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    if (persist) {
      try { localStorage.setItem("planner_theme", theme); } catch (e) { /* sin almacenamiento */ }
    }
    document.getElementById("theme-icon").textContent = theme === "dark" ? "☀️" : "🌙";
    document.getElementById("theme-label").textContent = theme === "dark" ? "Modo claro" : "Modo oscuro";
    applyChartTheme();
  }
  document.getElementById("btn-theme-toggle").onclick = () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
    refreshAll();
  };

  /* =========================================================
     BÚSQUEDA
     ========================================================= */
  const globalSearchInput = document.getElementById("global-search");
  const btnClearSearch = document.getElementById("btn-clear-search");

  globalSearchInput.addEventListener("input", (e) => {
    highlightTodayColumn = false;
    stateFilters.search = e.target.value;
    btnClearSearch.style.display = e.target.value.length > 0 ? "inline-block" : "none";
    refreshAll();
  });

  btnClearSearch.onclick = () => {
    globalSearchInput.value = "";
    stateFilters.search = "";
    btnClearSearch.style.display = "none";
    refreshAll();
  };

  /* =========================================================
     IMPORTACIÓN DESDE EXCEL
     ========================================================= */
  const excelUpload = document.getElementById("excel-upload");
  document.getElementById("btn-import-excel").onclick = () => excelUpload.click();

  function parseExcelDate(v) {
    if (v === null || v === undefined || v === "") return todayISO();
    if (typeof v === "number" && !isNaN(v)) {
      // Número de serie de Excel (se leen componentes UTC para no correr el día por zona horaria)
      const d = new Date(Math.round((v - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    if (v instanceof Date) return toLocalISO(v);
    const str = String(v).trim();
    const dmy = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    return todayISO();
  }

  excelUpload.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const workbook = XLSX.read(new Uint8Array(evt.target.result), { type: "array" });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(worksheet, { raw: true });
        let importedCount = 0, skipped = 0;
        const unmatched = {};   // V4: responsables del Excel que no coinciden con ningún cargo
        const activeUsers = store.getActiveUsers();
        const defaultUser = activeUsers[0] || store.users[0];

        rows.forEach(row => {
          const getCol = (name) => {
            const key = Object.keys(row).find(k => k.toLowerCase().includes(name.toLowerCase()));
            return key ? row[key] : null;
          };

          const title = getCol("tarea") || getCol("nombre");
          if (!title) { skipped++; return; }

          const resName = getCol("responsable");
          let assigneeId = defaultUser.id;
          if (resName) {
            const key = String(resName).trim().toLowerCase();
            const found = activeUsers.find(u => u.name.toLowerCase() === key) ||
                          store.users.find(u => u.name.toLowerCase() === key);
            if (found) assigneeId = found.id;
            else unmatched[String(resName).trim()] = (unmatched[String(resName).trim()] || 0) + 1;
          } else {
            unmatched["(sin responsable)"] = (unmatched["(sin responsable)"] || 0) + 1;
          }

          const frequency = normalizeOption(getCol("frecuencia"), ["Diario", "Semanal", "Mensual", "Variable"], "Mensual");
          const priority = normalizeOption(getCol("prioridad"), ["Baja", "Media", "Crítica"], "Media");
          const status = normalizeOption(getCol("estado"), STATUSES, "Pendiente");

          const rawStart = getCol("inicio");
          const rawEnd = getCol("término") || getCol("termino") || rawStart;
          const startDate = parseExcelDate(rawStart);
          let endDate = parseExcelDate(rawEnd);
          if (endDate < startDate) endDate = startDate;

          store.saveTask({
            id: null,
            title: String(title).trim(),
            assigneeId, frequency, priority, status, startDate, endDate
          }, { source: "Importación" });
          importedCount++;
        });

        excelUpload.value = "";
        refreshAll();

        let msg = `Se agregaron ${importedCount} tareas nuevas desde tu planilla Excel.`;
        if (skipped > 0) msg += `\n${skipped} fila(s) se omitieron por no tener nombre de tarea.`;
        const unmatchedKeys = Object.keys(unmatched);
        if (unmatchedKeys.length) {
          const total = unmatchedKeys.reduce((a, k) => a + unmatched[k], 0);
          msg += `\n\nOjo: ${total} tarea(s) quedaron asignadas a "${defaultUser.name}" porque su responsable no coincide con ningún cargo: ` +
                 unmatchedKeys.map(k => `${k} (${unmatched[k]})`).join(", ") +
                 `.\nRevísalas, o crea esos cargos en "Administrar cargos" antes de importar.`;
        }
        showConfirmModal("Importación exitosa", msg, () => {}, { hideCancel: true, icon: "✅" });
      } catch (error) {
        console.error(error);
        alert("Ocurrió un error al leer el archivo. Asegúrate de que es un Excel válido (.xlsx o .csv).");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  /* =========================================================
     UTILIDADES DE INTERFAZ
     ========================================================= */
  function triggerCelebration() {
    if (typeof confetti === "function") {
      confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 }, colors: ["#10b981", "#ffffff", "#3b82f6"] });
    }
  }

  function showConfirmModal(title, message, onAccept, opts = {}) {
    const modal = document.getElementById("confirm-modal");
    document.getElementById("confirm-icon").innerText = opts.icon || "⚠️";
    document.getElementById("confirm-title").innerText = title;
    document.getElementById("confirm-message").innerText = message;

    const btnCancel = document.getElementById("btn-confirm-cancel");
    const btnAccept = document.getElementById("btn-confirm-accept");
    btnCancel.style.display = opts.hideCancel ? "none" : "inline-block";
    btnAccept.innerText = opts.acceptText || "Aceptar";

    // Casilla opcional (ej.: "Borrar también del Historial")
    const checkWrap = document.getElementById("confirm-check-wrap");
    const checkInput = document.getElementById("confirm-check");
    if (opts.checkbox) {
      checkWrap.style.display = "flex";
      document.getElementById("confirm-check-label").innerText = opts.checkbox.label;
      checkInput.checked = opts.checkbox.checked !== false;
    } else {
      checkWrap.style.display = "none";
    }

    modal.classList.add("active");

    const cleanup = () => {
      modal.classList.remove("active");
      btnAccept.onclick = null;
      btnCancel.onclick = null;
    };
    btnAccept.onclick = () => { const checked = checkInput.checked; cleanup(); onAccept(checked); };
    btnCancel.onclick = () => { cleanup(); };
  }

  /* =========================================================
     BARRA DE PERIODO (COMPARTIDA)
     ========================================================= */
  document.getElementById("btn-period-prev").onclick = () => {
    highlightTodayColumn = false;
    periodDate = new Date(periodDate.getFullYear(), periodDate.getMonth() - 1, 1);
    refreshAll();
  };
  document.getElementById("btn-period-next").onclick = () => {
    highlightTodayColumn = false;
    periodDate = new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 1);
    refreshAll();
  };
  document.getElementById("btn-period-today").onclick = () => {
    periodDate = firstDayOfMonth(new Date());
    highlightTodayColumn = true;
    refreshAll();
  };

  // VACIAR MES: borra todas las tareas visibles del mes (respeta los filtros activos)
  document.getElementById("btn-period-clear").onclick = () => {
    const tasks = getPeriodTasks();
    if (tasks.length === 0) {
      showConfirmModal("Sin tareas", `No hay tareas visibles en ${periodLabel()} para borrar.`, () => {}, { hideCancel: true, icon: "ℹ️" });
      return;
    }
    const r = periodRange();
    const crossing = tasks.filter(t => t.startDate < r.start || t.endDate > r.end).length;
    let msg = `Se borrarán ${tasks.length} tarea(s) visibles en ${periodLabel()}.`;
    if (crossing > 0) msg += `\nOjo: ${crossing} de ellas comparten plazo con otro mes y también se borrarán.`;
    msg += `\nSi tienes filtros activos (cargo, prioridad, búsqueda), solo se borran las que ves.`;
    showConfirmModal(
      `¿Vaciar ${periodLabel()}?`,
      msg,
      (purge) => {
        const n = store.deleteTasks(tasks.map(t => t.id), { purgeLog: purge });
        refreshAll();
        showConfirmModal("Mes vaciado", `Se borraron ${n} tarea(s) de ${periodLabel()}.`, () => {}, { hideCancel: true, icon: "✅" });
      },
      { acceptText: "Vaciar mes", checkbox: { label: "Borrar también sus registros del Historial de Gestión", checked: true } }
    );
  };

  /* =========================================================
     KANBAN (drag & drop + cronómetro)
     ========================================================= */
  function renderKanban(tasks) {
    if (timerInterval) clearInterval(timerInterval);

    STATUSES.forEach(st => {
      const list = document.getElementById(`kanban-${st}`);
      const col = list.parentElement;
      list.innerHTML = "";

      col.ondragover = (e) => { e.preventDefault(); col.classList.add("drag-over"); };
      col.ondragleave = () => col.classList.remove("drag-over");
      col.ondrop = (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        const task = store.tasks.find(t => t.id === taskId);
        if (task && task.status !== st) {
          const wasCompleted = task.status === "Completada";
          // El Store pausa/reanuda el cronómetro y registra el movimiento
          store.saveTask({ id: task.id, status: st });
          if (st === "Completada" && !wasCompleted) triggerCelebration();
          refreshAll();
        }
      };

      const filtered = tasks.filter(t => t.status === st);
      document.getElementById(`count-${st}`).innerText = filtered.length;

      if (filtered.length === 0) {
        list.innerHTML = `<div class="kanban-empty">Sin tareas en ${periodLabel()}</div>`;
        return;
      }

      filtered.forEach(t => {
        const user = store.getUserById(t.assigneeId);
        const card = document.createElement("div");
        card.className = `kanban-card border-${statusKey(t.status)}`;
        card.draggable = true;
        card.ondragstart = (e) => { e.dataTransfer.setData("text/plain", t.id); card.classList.add("dragging"); };
        card.ondragend = () => card.classList.remove("dragging");
        card.onclick = () => window.editTask(t.id);

        let timerHTML = "";
        if (t.status === "En proceso") {
          timerHTML = `<div class="kanban-timer timer-process">⏱️ En curso: <span class="live-timer" data-task-id="${t.id}">${formatDuration(elapsedOf(t))}</span></div>`;
        } else if (t.status === "Completada") {
          timerHTML = `<div class="kanban-timer timer-completed">⏱️ Tiempo tomado: ${formatDuration(t.totalProcessTime || 0)}</div>`;
        } else if (t.totalProcessTime && t.totalProcessTime > 0) {
          timerHTML = `<div class="kanban-timer timer-paused">⏱️ Pausado: ${formatDuration(t.totalProcessTime)}</div>`;
        }

        const overdueHTML = isOverdue(t) ? ` <span class="badge-tag badge-overdue">⏰ Atrasada ${daysLate(t)}d</span>` : "";

        const moveOptions = STATUSES.filter(s => s !== t.status).map(s => `<option value="${s}">${s}</option>`).join("");
        card.innerHTML = `
          <div class="kanban-card-title">${escapeHtml(t.title)}</div>
          <div class="kanban-card-meta">👤 ${escapeHtml(user.name)} | ⚡ ${escapeHtml(t.priority)}</div>
          <div class="kanban-card-meta">📅 ${formatDateCL(t.startDate)} al ${formatDateCL(t.endDate)}${overdueHTML}</div>
          ${timerHTML}
          <div class="kanban-move">
            <select aria-label="Mover tarea a otro estado"><option value="">↪ Mover a…</option>${moveOptions}</select>
          </div>
        `;
        // V4: en celular no existe "arrastrar y soltar"; este selector cambia el estado
        const moveSel = card.querySelector(".kanban-move select");
        moveSel.onclick = (e) => e.stopPropagation();
        moveSel.onchange = (e) => {
          e.stopPropagation();
          const target = moveSel.value;
          if (!target) return;
          const wasCompleted = t.status === "Completada";
          store.saveTask({ id: t.id, status: target });
          if (target === "Completada" && !wasCompleted) triggerCelebration();
          refreshAll();
        };
        list.appendChild(card);
      });
    });

    timerInterval = setInterval(() => {
      document.querySelectorAll(".live-timer").forEach(span => {
        const task = store.tasks.find(x => x.id === span.dataset.taskId);
        if (task && task.status === "En proceso") span.innerText = formatDuration(elapsedOf(task));
      });
    }, 1000);
  }

  /* =========================================================
     CARTA GANTT (con botones Editar / Borrar)
     ========================================================= */
  function renderGantt(tasks) {
    const container = document.getElementById("gantt-container");

    if (document.getElementById("gantt-hide-completed").checked) {
      tasks = tasks.filter(t => t.status !== "Completada");
    }

    const grouped = {};
    tasks.forEach(task => {
      const key = `${task.title.trim().toUpperCase()}|${task.assigneeId}`;
      if (!grouped[key]) grouped[key] = { title: task.title, assigneeId: task.assigneeId, frequency: task.frequency, items: [], minStart: task.startDate };
      grouped[key].items.push(task);
      if (task.startDate < grouped[key].minStart) grouped[key].minStart = task.startDate;
    });
    const groups = Object.values(grouped).sort((a, b) => a.minStart.localeCompare(b.minStart) || a.title.localeCompare(b.title));
    groups.forEach(g => g.items.sort((a, b) => a.startDate.localeCompare(b.startDate)));

    const year = periodDate.getFullYear();
    const month = periodDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const isCurrentMonthView = today.getFullYear() === year && today.getMonth() === month;
    const todayDay = today.getDate();
    const monthShort = MONTHS[month].slice(0, 3).toUpperCase();
    const daysHeader = ["LUN", "MAR", "MIE", "JUE", "VIE", "SAB", "DOM"];
    const cellW = ganttCellWidthClass === "zoom-compact" ? 28 : (ganttCellWidthClass === "zoom-normal" ? 38 : 52);

    const dayClasses = (day) => {
      const date = new Date(year, month, day);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isTodayCol = highlightTodayColumn && isCurrentMonthView && day === todayDay;
      return `${ganttCellWidthClass} ${isWeekend ? "weekend" : ""} ${isTodayCol ? "today-highlight" : ""}`;
    };

    let html = `<div class="gantt-row gantt-header-row"><div class="gantt-col-task">TAREA / RESPONSABLE</div><div class="gantt-row-grid">`;
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      html += `
        <div class="gantt-col-day header-day ${dayClasses(day)}">
          <span class="day-name">${daysHeader[(date.getDay() + 6) % 7]}</span>
          <span class="day-number">${pad(day)}</span>
          <span class="day-month">${monthShort}</span>
        </div>`;
    }
    html += `</div></div>`;

    if (groups.length === 0) {
      html += `<div class="gantt-empty">No hay tareas con plazo en ${periodLabel()} para los filtros seleccionados.</div>`;
      container.innerHTML = html;
      return;
    }

    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month, daysInMonth);

    groups.forEach(group => {
      const user = store.getUserById(group.assigneeId);
      const multi = group.items.length > 1;

      const actionsHTML = group.items.map(t => `
        <div class="gantt-item-actions">
          ${multi ? `<span class="gantt-item-dates">${fmtShort(t.startDate)} – ${fmtShort(t.endDate)}</span>` : ""}
          <button type="button" class="icon-btn" title="Editar tarea" onclick="editTask('${t.id}')">✏️ Editar</button>
          <button type="button" class="icon-btn icon-btn-danger" title="Borrar tarea" onclick="deleteTask('${t.id}')">🗑️ Borrar</button>
        </div>`).join("");

      html += `<div class="gantt-row">
        <div class="gantt-col-task">
          <div class="gantt-task-title">${escapeHtml(group.title)}</div>
          <div class="gantt-task-badges">
            <span class="badge-tag badge-role">${escapeHtml(user.name)}</span>
            <span class="badge-tag badge-freq">${escapeHtml(group.frequency)}</span>
          </div>
          <div class="gantt-row-actions">${actionsHTML}</div>
        </div>
        <div class="gantt-row-grid">`;

      for (let day = 1; day <= daysInMonth; day++) {
        html += `<div class="gantt-col-day ${dayClasses(day)}"></div>`;
      }

      group.items.forEach(task => {
        const taskStart = parseLocalDate(task.startDate);
        const taskEnd = parseLocalDate(task.endDate);
        if (taskStart <= monthEnd && taskEnd >= monthStart) {
          const visibleStart = taskStart < monthStart ? monthStart : taskStart;
          const visibleEnd = taskEnd > monthEnd ? monthEnd : taskEnd;
          const left = (visibleStart.getDate() - 1) * cellW;
          const width = (visibleEnd.getDate() - visibleStart.getDate() + 1) * cellW;
          html += `
            <div class="gantt-continuous-bar bar-${statusKey(task.status)}" style="left:${left}px; width:${width}px;"
                 title="${escapeHtml(task.title)} (${escapeHtml(task.status)}) - clic para editar" onclick="editTask('${task.id}')">
              <span class="gantt-bar-title">${escapeHtml(task.title)}</span>
              <span class="gantt-bar-dates">${fmtShort(task.startDate)} al ${fmtShort(task.endDate)}</span>
            </div>`;
        }
      });

      html += `</div></div>`;
    });

    container.innerHTML = html;

    // V4: en celular, si se ve el mes actual, desplaza la carta hasta unos días antes de hoy
    if (isMobile() && isCurrentMonthView) {
      const wrapper = container.parentElement;
      wrapper.scrollLeft = Math.max(0, (todayDay - 3) * cellW);
    }
  }

  document.getElementById("gantt-hide-completed").addEventListener("change", () => refreshAll());

  document.querySelectorAll(".zoom-btn").forEach((btn, idx) => {
    btn.onclick = () => {
      document.querySelectorAll(".zoom-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      ganttCellWidthClass = idx === 0 ? "zoom-compact" : idx === 1 ? "zoom-normal" : "zoom-detailed";
      refreshAll();
    };
  });

  /* =========================================================
     SIDEBAR Y FILTROS
     ========================================================= */
  function renderUserSidebarFilters() {
    const container = document.getElementById("filter-users-list");
    const r = periodRange();
    const monthTasks = store.getTasks({ periodStart: r.start, periodEnd: r.end });
    // V4: si el cargo filtrado fue eliminado, se vuelve a "Todos"
    if (stateFilters.assigneeId !== "ALL" && !store.users.some(u => u.id === stateFilters.assigneeId)) {
      stateFilters.assigneeId = "ALL";
    }

    let html = `
      <div class="user-filter-item ${stateFilters.assigneeId === "ALL" ? "active" : ""}" data-id="ALL">
        <span>Todos los Cargos</span>
        <span class="count-badge">${monthTasks.length}</span>
      </div>`;

    store.users.forEach(u => {
      const uCount = monthTasks.filter(t => t.assigneeId === u.id).length;
      // Los inactivos solo se muestran si tienen tareas en el mes (o si están seleccionados)
      if (u.active === false && uCount === 0 && stateFilters.assigneeId !== u.id) return;
      html += `
        <div class="user-filter-item ${stateFilters.assigneeId === u.id ? "active" : ""} ${u.active === false ? "inactive" : ""}" data-id="${u.id}">
          <span>${escapeHtml(cargoLabel(u))}</span>
          <span class="count-badge">${uCount}</span>
        </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll(".user-filter-item").forEach(item => {
      item.addEventListener("click", () => {
        highlightTodayColumn = false;
        stateFilters.assigneeId = item.dataset.id;
        refreshAll();
      });
    });
  }

  function setChipActive(groupId, value) {
    document.getElementById(groupId).querySelectorAll(".chip").forEach(c => {
      c.classList.toggle("active", c.dataset.value === value);
    });
  }

  function setupChipGroup(groupId, stateKey) {
    document.getElementById(groupId).querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        highlightTodayColumn = false;
        stateFilters[stateKey] = chip.dataset.value;
        setChipActive(groupId, chip.dataset.value);
        refreshAll();
      });
    });
  }
  setupChipGroup("chip-priority-group", "priority");
  setupChipGroup("chip-freq-group", "frequency");

  document.getElementById("filter-date-from").addEventListener("change", (e) => { highlightTodayColumn = false; stateFilters.dateFrom = e.target.value; refreshAll(); });
  document.getElementById("filter-date-to").addEventListener("change", (e) => { highlightTodayColumn = false; stateFilters.dateTo = e.target.value; refreshAll(); });
  document.getElementById("btn-clear-dates").onclick = () => {
    highlightTodayColumn = false;
    document.getElementById("filter-date-from").value = "";
    document.getElementById("filter-date-to").value = "";
    stateFilters.dateFrom = "";
    stateFilters.dateTo = "";
    refreshAll();
  };
  document.getElementById("btn-audit-critical").onclick = () => {
    highlightTodayColumn = false;
    stateFilters.priority = "Crítica";
    setChipActive("chip-priority-group", "Crítica");
    refreshAll();
  };

  /* =========================================================
     PESTAÑAS
     ========================================================= */
  const tabBtns = document.querySelectorAll(".tab-btn");
  const viewPanels = document.querySelectorAll(".view-panel");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.remove("active"));
      viewPanels.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
      refreshAll();
    });
  });

  /* =========================================================
     MODAL DE TAREA
     ========================================================= */
  const taskModal = document.getElementById("task-modal");
  document.getElementById("btn-add-task").onclick = () => window.openModal();
  document.querySelector(".close-modal").onclick = () => taskModal.classList.remove("active");

  document.getElementById("btn-modal-delete").onclick = () => {
    const id = document.getElementById("task-id").value;
    if (!id) return;
    taskModal.classList.remove("active");
    window.deleteTask(id);
  };

  document.getElementById("task-form").onsubmit = (e) => {
    e.preventDefault();

    const today = todayISO();
    const startDate = document.getElementById("task-start").value;
    const endDate = document.getElementById("task-end").value;
    const taskId = document.getElementById("task-id").value || null;

    if (!taskId && startDate < today) {
      alert("⚠️ No es posible registrar nuevas tareas con fecha de inicio anterior a la fecha actual.");
      return;
    }
    if (endDate < startDate) {
      alert("⚠️ La fecha de término no puede ser anterior a la fecha de inicio.");
      return;
    }

    const previousTask = taskId ? store.tasks.find(t => t.id === taskId) : null;
    const newStatus = document.getElementById("task-status").value;

    const savedId = store.saveTask({
      id: taskId,
      title: document.getElementById("task-title").value.trim(),
      assigneeId: document.getElementById("task-assignee").value,
      frequency: document.getElementById("task-frequency").value,
      priority: document.getElementById("task-priority").value,
      status: newStatus,
      startDate,
      endDate
    });

    if (newStatus === "Completada" && (!previousTask || previousTask.status !== "Completada")) {
      triggerCelebration();
    }

    // Si la tarea nueva no cae en el mes visible, se navega al mes de su inicio para que la veas
    if (!taskId && savedId) {
      const r = periodRange();
      if (endDate < r.start || startDate > r.end) {
        periodDate = firstDayOfMonth(parseLocalDate(startDate));
      }
    }

    taskModal.classList.remove("active");
    refreshAll();
  };

  /**
   * V4: lista de responsables del formulario. Solo cargos activos,
   * más el cargo actual de la tarea si está inactivo (para no perderlo al editar).
   */
  function populateAssignees(currentId) {
    const list = store.users.filter(u => u.active !== false || u.id === currentId);
    if (currentId && !list.some(u => u.id === currentId)) list.push(store.getUserById(currentId));
    document.getElementById("task-assignee").innerHTML =
      list.map(u => `<option value="${u.id}">${escapeHtml(cargoLabel(u))}</option>`).join("");
  }

  window.openModal = function () {
    populateAssignees();
    document.getElementById("task-form").reset();
    document.getElementById("task-id").value = "";
    document.getElementById("modal-title").innerText = "Agregar Nueva Tarea";
    document.getElementById("btn-modal-delete").style.display = "none";

    const today = todayISO();
    const r = periodRange();
    const suggestedStart = r.start > today ? r.start : today;
    const startInput = document.getElementById("task-start");
    const endInput = document.getElementById("task-end");
    startInput.min = today;
    endInput.min = today;
    startInput.value = suggestedStart;
    endInput.value = suggestedStart;

    if (stateFilters.assigneeId !== "ALL" && store.getUserById(stateFilters.assigneeId).active !== false) {
      document.getElementById("task-assignee").value = stateFilters.assigneeId;
    }
    taskModal.classList.add("active");
  };

  window.editTask = function (id) {
    const t = store.tasks.find(x => x.id === id);
    if (!t) return;

    document.getElementById("task-start").removeAttribute("min");
    document.getElementById("task-end").removeAttribute("min");

    populateAssignees(t.assigneeId);
    document.getElementById("modal-title").innerText = "Editar Tarea";
    document.getElementById("btn-modal-delete").style.display = "inline-block";
    document.getElementById("task-id").value = t.id;
    document.getElementById("task-title").value = t.title;
    document.getElementById("task-assignee").value = t.assigneeId;
    document.getElementById("task-frequency").value = t.frequency || "Mensual";
    document.getElementById("task-priority").value = t.priority;
    document.getElementById("task-status").value = t.status;
    document.getElementById("task-start").value = t.startDate;
    document.getElementById("task-end").value = t.endDate;

    taskModal.classList.add("active");
  };

  window.deleteTask = function (id) {
    const t = store.tasks.find(x => x.id === id);
    if (!t) return;
    showConfirmModal(
      "¿Eliminar esta tarea?",
      `"${t.title}" (${formatDateCL(t.startDate)} al ${formatDateCL(t.endDate)}) se eliminará del planificador.`,
      (purge) => { store.deleteTask(id, { purgeLog: purge }); refreshAll(); },
      { acceptText: "Eliminar", checkbox: { label: "Borrar también sus registros del Historial de Gestión", checked: true } }
    );
  };

  /* =========================================================
     V4: ADMINISTRAR CARGOS
     Se trabaja sobre un BORRADOR (cargosDraft); nada se guarda
     hasta presionar "Guardar cambios" y confirmar el resumen.
     ========================================================= */
  const cargosModal = document.getElementById("cargos-modal");
  let cargosDraft = [];      // [{ id|null, tmpKey, name, active }]
  let cargosDeleted = [];    // códigos a eliminar

  function cargosMsg(text) {
    document.getElementById("cargos-msg").innerText = text || "";
  }

  function openCargosModal() {
    cargosDraft = store.users.map(u => ({ id: u.id, tmpKey: u.id, name: u.name, active: u.active !== false }));
    cargosDeleted = [];
    cargosMsg("");
    document.getElementById("cargo-new-name").value = "";

    const warn = document.getElementById("cargos-warning");
    const readOnly = store.cargosMode !== "cloud";
    warn.style.display = readOnly ? "block" : "none";
    warn.innerText = readOnly
      ? "⚠️ Las reglas de Firestore todavía no incluyen la colección \"planner_cargos\". " +
        "Mientras tanto se usa la lista fija del código y no se pueden guardar cambios. " +
        "Agrega la línea indicada en el archivo firestore.rules de la V4 y presiona Publicar en Firebase."
      : "";
    document.getElementById("btn-cargos-save").disabled = readOnly;
    document.getElementById("btn-cargo-add").disabled = readOnly;

    renderCargosDraft();
    if (isMobile()) closeSidebar();
    cargosModal.classList.add("active");
  }

  function cargoMetaHTML(c) {
    const n = c.id ? store.countTasksByCargo(c.id) : 0;
    const original = c.id ? store.users.find(u => u.id === c.id) : null;
    const renamed = original && original.name !== c.name.trim();
    return `${c.id ? `${n} tarea(s) en total` : `<span class="cargo-new">Nuevo</span>`}` +
      (renamed ? ` · <span class="cargo-renamed">antes: ${escapeHtml(original.name)}</span>` : "");
  }

  function renderCargosDraft() {
    const box = document.getElementById("cargos-list");
    if (cargosDraft.length === 0) {
      box.innerHTML = `<div class="kanban-empty">No hay cargos. Agrega al menos uno.</div>`;
      return;
    }
    box.innerHTML = cargosDraft.map((c, i) => {
      const canDelete = !c.id || store.countTasksByCargo(c.id) === 0;
      return `
        <div class="cargo-row ${c.active ? "" : "is-inactive"}" data-key="${escapeHtml(c.tmpKey)}">
          <div class="cargo-order">
            <button type="button" class="icon-btn" data-act="up" ${i === 0 ? "disabled" : ""} title="Subir">▲</button>
            <button type="button" class="icon-btn" data-act="down" ${i === cargosDraft.length - 1 ? "disabled" : ""} title="Bajar">▼</button>
          </div>
          <div class="cargo-main">
            <input type="text" class="cargo-name" maxlength="40" value="${escapeHtml(c.name)}" aria-label="Nombre del cargo">
            <div class="cargo-meta">${cargoMetaHTML(c)}</div>
          </div>
          <label class="toggle-control cargo-active" title="Activo / inactivo">
            <input type="checkbox" data-act="active" ${c.active ? "checked" : ""}>
            <span class="toggle-slider"></span>
            <span class="toggle-label">${c.active ? "Activo" : "Inactivo"}</span>
          </label>
          <button type="button" class="icon-btn icon-btn-danger" data-act="del" ${canDelete ? "" : "disabled"}
            title="${canDelete ? "Eliminar cargo" : "Tiene tareas: no se puede eliminar. Desactívalo."}">🗑️</button>
        </div>`;
    }).join("");

    box.querySelectorAll(".cargo-row").forEach(row => {
      const key = row.dataset.key;
      const idx = () => cargosDraft.findIndex(c => c.tmpKey === key);
      row.querySelector(".cargo-name").addEventListener("input", (e) => {
        const c = cargosDraft[idx()];
        c.name = e.target.value;
        row.querySelector(".cargo-meta").innerHTML = cargoMetaHTML(c);
      });
      row.querySelectorAll("[data-act]").forEach(el => {
        const act = el.dataset.act;
        if (act === "active") {
          el.addEventListener("change", () => { cargosDraft[idx()].active = el.checked; renderCargosDraft(); });
          return;
        }
        el.addEventListener("click", () => {
          const i = idx();
          if (act === "up" && i > 0) [cargosDraft[i - 1], cargosDraft[i]] = [cargosDraft[i], cargosDraft[i - 1]];
          if (act === "down" && i < cargosDraft.length - 1) [cargosDraft[i + 1], cargosDraft[i]] = [cargosDraft[i], cargosDraft[i + 1]];
          if (act === "del") {
            const c = cargosDraft[i];
            if (c.id && store.countTasksByCargo(c.id) > 0) return;
            if (c.id) cargosDeleted.push(c.id);
            cargosDraft.splice(i, 1);
          }
          cargosMsg("");
          renderCargosDraft();
        });
      });
    });
  }

  function addCargoToDraft() {
    const input = document.getElementById("cargo-new-name");
    const name = input.value.trim();
    if (!name) { cargosMsg("Escribe el nombre del nuevo cargo."); input.focus(); return; }
    if (cargosDraft.some(c => c.name.trim().toLowerCase() === name.toLowerCase())) {
      cargosMsg(`Ya existe un cargo llamado "${name}".`); input.focus(); return;
    }
    cargosDraft.push({ id: null, tmpKey: "new-" + Date.now(), name, active: true });
    input.value = "";
    cargosMsg("");
    renderCargosDraft();
  }

  /** Revisa el borrador y arma el resumen de cambios. Devuelve null si hay errores. */
  function validateCargosDraft() {
    const names = new Set();
    for (const c of cargosDraft) {
      const n = c.name.trim();
      if (!n) { cargosMsg("Hay un cargo sin nombre. Escríbelo o elimínalo."); return null; }
      if (names.has(n.toLowerCase())) { cargosMsg(`El nombre "${n}" está repetido. Cada cargo debe tener un nombre distinto.`); return null; }
      names.add(n.toLowerCase());
    }
    if (!cargosDraft.some(c => c.active)) { cargosMsg("Debe quedar al menos un cargo activo."); return null; }

    const lines = [];
    cargosDraft.forEach(c => {
      const orig = c.id ? store.users.find(u => u.id === c.id) : null;
      if (!orig) { lines.push(`➕ Nuevo: ${c.name.trim()}`); return; }
      if (orig.name !== c.name.trim()) lines.push(`✏️ Renombrar: ${orig.name} → ${c.name.trim()} (${store.countTasksByCargo(c.id)} tarea/s)`);
      if ((orig.active !== false) && !c.active) lines.push(`⏸️ Desactivar: ${c.name.trim()}`);
      if ((orig.active === false) && c.active) lines.push(`▶️ Reactivar: ${c.name.trim()}`);
    });
    cargosDeleted.forEach(id => lines.push(`🗑️ Eliminar: ${store.getUserById(id).name}`));
    const origOrder = store.users.filter(u => !cargosDeleted.includes(u.id)).map(u => u.id).join("|");
    const newOrder = cargosDraft.filter(c => c.id).map(c => c.id).join("|");
    if (origOrder !== newOrder) lines.push("↕️ Cambia el orden de la lista");
    return lines;
  }

  document.getElementById("btn-manage-cargos").onclick = openCargosModal;
  document.getElementById("cargos-close").onclick = () => cargosModal.classList.remove("active");
  document.getElementById("btn-cargos-cancel").onclick = () => cargosModal.classList.remove("active");
  document.getElementById("btn-cargo-add").onclick = addCargoToDraft;
  document.getElementById("cargo-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCargoToDraft(); }
  });
  document.getElementById("btn-cargos-save").onclick = () => {
    const lines = validateCargosDraft();
    if (!lines) return;
    if (lines.length === 0) { cargosModal.classList.remove("active"); return; }
    showConfirmModal(
      "¿Guardar cambios en los cargos?",
      lines.join("\n") + "\n\nLos cambios se aplican para todos los usuarios del planificador.",
      () => {
        const ok = store.saveCargos(cargosDraft, cargosDeleted);
        cargosModal.classList.remove("active");
        if (!ok) { alert("No se pudieron guardar los cargos: revisa las reglas de Firestore."); return; }
        refreshAll();
      },
      { acceptText: "Guardar", icon: "⚙️" }
    );
  };

  /* =========================================================
     V4: MENÚ LATERAL PLEGABLE (CELULAR)
     ========================================================= */
  function openSidebar() { document.body.classList.add("sidebar-open"); }
  function closeSidebar() { document.body.classList.remove("sidebar-open"); }
  document.getElementById("btn-sidebar-open").onclick = openSidebar;
  document.getElementById("btn-sidebar-close").onclick = closeSidebar;
  document.getElementById("sidebar-backdrop").onclick = closeSidebar;
  document.getElementById("btn-mobile-add").onclick = () => window.openModal();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });
  // Al pasar a pantalla ancha, el menú vuelve a su lugar normal
  window.matchMedia("(max-width: 900px)").addEventListener("change", (e) => { if (!e.matches) closeSidebar(); });

  /* =========================================================
     RENDER GENERAL
     ========================================================= */
  function refreshAll() {
    const activeView = document.querySelector(".tab-btn.active").dataset.view;
    renderCurrentView(activeView);
  }

  function renderCurrentView(view) {
    if (view !== "kanban" && timerInterval) { clearInterval(timerInterval); timerInterval = null; }

    const tasks = getPeriodTasks();

    document.getElementById("period-badge").innerText = periodLabel();
    document.getElementById("period-info").innerText = `${tasks.length} tarea(s) con plazo en ${periodLabel()}`;
    document.getElementById("period-bar").style.display = view === "history" ? "none" : "flex";

    renderUserSidebarFilters();
    updateKPIs(tasks);
    updateAlertBanner();

    if (view === "gantt") renderGantt(tasks);
    if (view === "kanban") renderKanban(tasks);
    if (view === "table") renderTable(tasks);
    if (view === "metrics") renderMetrics(tasks);
    if (view === "report") renderReport(tasks);
    if (view === "history") renderHistory();
  }

  function updateKPIs(tasks) {
    document.getElementById("kpi-total").innerText = tasks.length;
    document.getElementById("kpi-completed").innerText = tasks.filter(t => t.status === "Completada").length;
    document.getElementById("kpi-process").innerText = tasks.filter(t => t.status === "En proceso").length;
    document.getElementById("kpi-critical").innerText = tasks.filter(t => t.priority === "Crítica" && t.status !== "Completada").length;
  }

  function updateAlertBanner() {
    const banner = document.getElementById("alert-banner");
    const msgEl = document.getElementById("alert-message");
    const overdue = store.tasks.filter(isOverdue);

    if (overdue.length === 0) {
      banner.classList.add("alert-ok");
      msgEl.innerText = "✅ Sin tareas atrasadas. Monitorea tareas críticas y desviaciones del plan de trabajo.";
      return;
    }
    banner.classList.remove("alert-ok");

    const byMonth = {};
    overdue.forEach(t => {
      const [y, m] = t.endDate.split("-");
      const key = `${y}-${m}`;
      byMonth[key] = (byMonth[key] || 0) + 1;
    });
    const detail = Object.keys(byMonth).sort().map(k => {
      const [y, m] = k.split("-");
      return `${MONTHS[Number(m) - 1]} ${y} (${byMonth[k]})`;
    }).join(", ");

    msgEl.innerText = `⚠️ ${overdue.length} tarea(s) con plazo vencido sin completar: ${detail}. Revísalas navegando a ese mes.`;
  }

  /* =========================================================
     VISTA TABLA
     ========================================================= */
  function renderTable(tasks) {
    const tbody = document.getElementById("table-tasks-body");
    if (tasks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No hay tareas con plazo en ${periodLabel()} para los filtros seleccionados.</td></tr>`;
      return;
    }

    const sorted = tasks.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    tbody.innerHTML = sorted.map(t => {
      const user = store.getUserById(t.assigneeId);
      const overdue = isOverdue(t) ? ` <span class="badge-tag badge-overdue">⏰ ${daysLate(t)}d</span>` : "";
      return `
        <tr>
          <td><strong>${escapeHtml(t.title)}</strong></td>
          <td>${escapeHtml(user.name)}</td>
          <td>${escapeHtml(t.frequency)}</td>
          <td>${priorityBadge(t.priority)}</td>
          <td>${statusBadge(t.status)}</td>
          <td>${formatDateCL(t.startDate)}</td>
          <td>${formatDateCL(t.endDate)}${overdue}</td>
          <td>${formatDuration(elapsedOf(t))}</td>
          <td>
            <div class="cell-actions">
              <button class="btn-secondary" onclick="editTask('${t.id}')">✏️ Editar</button>
              <button class="btn-secondary" style="color:var(--color-status-pending)" onclick="deleteTask('${t.id}')">🗑️</button>
            </div>
          </td>
        </tr>`;
    }).join("");
  }

  /* =========================================================
     HISTORIAL DE GESTIÓN (BITÁCORA)
     ========================================================= */
  document.getElementById("history-month-filter").addEventListener("change", (e) => { historyFilters.month = e.target.value; refreshAll(); });
  document.getElementById("history-year-filter").addEventListener("change", (e) => { historyFilters.year = e.target.value; refreshAll(); });
  document.getElementById("history-action-filter").addEventListener("change", (e) => { historyFilters.action = e.target.value; refreshAll(); });
  document.getElementById("btn-history-clear").onclick = () => {
    historyFilters = { month: "ALL", year: "ALL", action: "ALL" };
    document.getElementById("history-month-filter").value = "ALL";
    document.getElementById("history-year-filter").value = "ALL";
    document.getElementById("history-action-filter").value = "ALL";
    refreshAll();
  };
  document.getElementById("btn-history-export").onclick = exportHistoryToExcel;
  document.getElementById("btn-history-purge").onclick = () => {
    const n = store.countOrphanLogs();
    if (n === 0) {
      showConfirmModal("Historial limpio", "No hay registros de tareas eliminadas en el historial.", () => {}, { hideCancel: true, icon: "✅" });
      return;
    }
    showConfirmModal(
      "¿Quitar tareas eliminadas del historial?",
      `Se quitarán ${n} registro(s) que pertenecen a tareas que ya no existen en el planificador.\nLos registros de tareas vigentes no se tocan.`,
      () => { store.purgeDeletedTasksFromLog(); refreshAll(); },
      { acceptText: "Quitar registros", icon: "🧹" }
    );
  };

  function populateHistoryYears() {
    const sel = document.getElementById("history-year-filter");
    const years = new Set(store.getLog().map(l => String(new Date(l.ts).getFullYear())));
    years.add(String(new Date().getFullYear()));
    const sorted = [...years].sort((a, b) => Number(b) - Number(a));
    sel.innerHTML = `<option value="ALL">Todos los años</option>` + sorted.map(y => `<option value="${y}">${y}</option>`).join("");
    if (historyFilters.year !== "ALL" && !sorted.includes(historyFilters.year)) historyFilters.year = "ALL";
    sel.value = historyFilters.year;
  }

  function getFilteredLogs() {
    return store.getLog().filter(l => {
      const d = new Date(l.ts);
      if (historyFilters.year !== "ALL" && String(d.getFullYear()) !== historyFilters.year) return false;
      if (historyFilters.month !== "ALL" && pad(d.getMonth() + 1) !== historyFilters.month) return false;
      if (historyFilters.action !== "ALL" && l.action !== historyFilters.action) return false;
      return true;
    }).sort((a, b) => b.ts - a.ts);
  }

  function movementClass(action) {
    if (action === "Creación") return "mov-create";
    if (action === "Importación") return "mov-import";
    if (action === "Edición") return "mov-edit";
    if (action === "Eliminación") return "mov-delete";
    return "mov-status";
  }

  function historyPeriodText() {
    const m = historyFilters.month, y = historyFilters.year;
    if (m === "ALL" && y === "ALL") return "todos los periodos";
    if (m === "ALL") return `todo el año ${y}`;
    if (y === "ALL") return `${MONTHS[Number(m) - 1]} de todos los años`;
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }

  function renderHistory() {
    populateHistoryYears();
    const tbody = document.getElementById("history-tasks-body");
    const logs = getFilteredLogs();
    lastHistoryRows = logs;

    document.getElementById("history-subtitle").innerText =
      `Bitácora de movimientos según la fecha en que se realizaron · Mostrando: ${historyPeriodText()}.`;

    const count = (fn) => logs.filter(fn).length;
    document.getElementById("history-summary").innerHTML = `
      <div class="summary-chip">Movimientos <strong>${logs.length}</strong></div>
      <div class="summary-chip">Creadas / importadas <strong>${count(l => l.action === "Creación" || l.action === "Importación")}</strong></div>
      <div class="summary-chip">Completadas <strong>${count(l => l.action === "Cambio de estado" && l.toStatus === "Completada")}</strong></div>
      <div class="summary-chip">Cambios de estado <strong>${count(l => l.action === "Cambio de estado")}</strong></div>
      <div class="summary-chip">Ediciones <strong>${count(l => l.action === "Edición")}</strong></div>
      <div class="summary-chip">Eliminaciones <strong>${count(l => l.action === "Eliminación")}</strong></div>
    `;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay movimientos registrados para ${historyPeriodText()}.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const d = new Date(l.ts);
      const dateStr = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
      const timeStr = l.migrated ? "fecha estimada" : `${pad(d.getHours())}:${pad(d.getMinutes())} hrs`;
      const userName = l.assigneeName || store.getUserById(l.assigneeId).name;
      const exists = store.tasks.some(t => t.id === l.taskId);

      let detailHTML = "";
      if (l.action === "Cambio de estado") {
        detailHTML = l.fromStatus
          ? `${statusBadge(l.fromStatus)}<span class="status-arrow">→</span>${statusBadge(l.toStatus)}`
          : statusBadge(l.toStatus);
      } else if (l.action === "Creación" || l.action === "Importación") {
        detailHTML = `Estado inicial: ${statusBadge(l.toStatus)}`;
      } else if (l.action === "Eliminación") {
        detailHTML = `Estado al eliminar: ${statusBadge(l.fromStatus)}`;
      }
      if (l.detail) detailHTML += `<div class="history-detail-note">${escapeHtml(l.detail)}</div>`;
      if (l.by) detailHTML += `<div class="history-detail-note">Registrado por: ${escapeHtml(l.by)}</div>`;

      const migratedTag = l.migrated ? `<span class="badge-tag badge-migrated">Migrado</span>` : "";
      const actionBtn = exists
        ? `<button class="btn-secondary" onclick="editTask('${l.taskId}')">👁️ Ver</button>`
        : `<span style="font-size:0.75rem; color:var(--text-faint);">Tarea eliminada</span>`;

      return `
        <tr>
          <td class="history-date">${dateStr}<small>${timeStr}</small></td>
          <td><strong>${escapeHtml(l.taskTitle)}</strong></td>
          <td>${escapeHtml(userName)}</td>
          <td><span class="mov-badge ${movementClass(l.action)}">${escapeHtml(l.action)}</span>${migratedTag}</td>
          <td>${detailHTML}</td>
          <td>${actionBtn}</td>
        </tr>`;
    }).join("");
  }

  function exportHistoryToExcel() {
    if (typeof XLSX === "undefined") { alert("No se pudo cargar la librería de Excel. Revisa tu conexión a internet."); return; }
    if (lastHistoryRows.length === 0) { alert("No hay movimientos para exportar con los filtros actuales."); return; }

    const rows = lastHistoryRows.map(l => {
      const d = new Date(l.ts);
      return {
        "Fecha": `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`,
        "Hora": l.migrated ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        "Tarea": l.taskTitle,
        "Responsable": l.assigneeName || store.getUserById(l.assigneeId).name,
        "Movimiento": l.action,
        "Estado anterior": l.fromStatus || "",
        "Estado nuevo": l.toStatus || "",
        "Detalle": l.detail || "",
        "Registrado por": l.by || "",
        "Origen del registro": l.migrated ? "Migrado (fecha estimada)" : "Registrado por el sistema"
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 12 }, { wch: 7 }, { wch: 45 }, { wch: 20 }, { wch: 17 }, { wch: 15 }, { wch: 15 }, { wch: 70 }, { wch: 28 }, { wch: 26 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Historial");
    const suffix = historyPeriodText().replace(/\s+/g, "_");
    XLSX.writeFile(wb, `Historial_Gestion_${suffix}.xlsx`);
  }

  /* =========================================================
     MÉTRICAS
     ========================================================= */
  function renderMetrics(tasks) {
    document.getElementById("metrics-subtitle").innerText = `Análisis y estadísticas visuales de ${periodLabel()}`;

    document.getElementById("workload-bars-container").innerHTML = cargosForTasks(tasks).map(u => {
      const userTasks = tasks.filter(t => t.assigneeId === u.id);
      const total = userTasks.length;
      const completed = userTasks.filter(t => t.status === "Completada").length;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      return `
        <div class="workload-item">
          <div class="workload-item-header">
            <span>${escapeHtml(cargoLabel(u))}</span>
            <span>${total} t. (${pct}% comp.)</span>
          </div>
          <div class="workload-progress-bg"><div class="workload-progress-fill" style="width:${pct}%;"></div></div>
        </div>`;
    }).join("");

    const completedCount = tasks.filter(t => t.status === "Completada").length;
    const processCount = tasks.filter(t => t.status === "En proceso").length;
    const pendingCount = tasks.filter(t => t.status === "Pendiente").length;
    const suspendedCount = tasks.filter(t => t.status === "Suspendida").length;
    const totalCount = tasks.length;
    const globalPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    document.getElementById("doughnut-percentage").innerText = `${globalPct}%`;
    document.getElementById("doughnut-legend").innerHTML = `
      <div class="legend-item"><span class="legend-dot" style="background:var(--color-status-completed);"></span> Completadas (${completedCount})</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--color-status-process);"></span> En Proceso (${processCount})</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--color-status-pending);"></span> Pendientes (${pendingCount})</div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--color-status-suspended);"></span> Suspendidas (${suspendedCount})</div>
    `;

    if (typeof Chart === "undefined") return;
    applyChartTheme();
    const ctx = document.getElementById("chartStatusDoughnut").getContext("2d");
    if (statusDoughnutChart) statusDoughnutChart.destroy();
    const emptyData = totalCount === 0;
    statusDoughnutChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: emptyData ? ["Sin tareas"] : ["Completadas", "En Proceso", "Pendientes", "Suspendidas"],
        datasets: [{
          data: emptyData ? [1] : [completedCount, processCount, pendingCount, suspendedCount],
          backgroundColor: emptyData ? [currentTheme() === "dark" ? "#26324a" : "#e2e8f0"] : ["#10b981", "#3b82f6", "#ef4444", "#eab308"],
          borderWidth: 0
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: "78%", plugins: { legend: { display: false }, tooltip: { enabled: !emptyData } } }
    });
  }

  /* =========================================================
     REPORTE MENSUAL
     ========================================================= */
  function renderReport(tasks) {
    document.getElementById("report-period").innerText = periodLabel().toUpperCase();
    document.getElementById("report-date").innerText = new Date().toLocaleDateString("es-CL");

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === "Completada").length;
    const process = tasks.filter(t => t.status === "En proceso").length;
    const pending = tasks.filter(t => t.status === "Pendiente").length;
    const criticals = tasks.filter(t => t.priority === "Crítica");
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById("report-kpi-summary").innerHTML = `
      <div class="report-kpi-tile"><label>Total del Mes</label><span>${total}</span></div>
      <div class="report-kpi-tile"><label>Completadas</label><span style="color:var(--color-status-completed)">${completed}</span></div>
      <div class="report-kpi-tile"><label>En Proceso</label><span style="color:var(--color-status-process)">${process}</span></div>
      <div class="report-kpi-tile"><label>Pendientes / Críticas</label><span style="color:var(--color-status-pending)">${pending} / ${criticals.length}</span></div>
    `;

    document.getElementById("report-progress-text").innerText = `${pct}%`;
    document.getElementById("report-progress-bar").style.width = `${pct}%`;

    const critTbody = document.getElementById("report-critical-tbody");
    critTbody.innerHTML = criticals.length === 0
      ? `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No hay tareas críticas en ${periodLabel()}.</td></tr>`
      : criticals.map(c => {
          const user = store.getUserById(c.assigneeId);
          return `<tr><td><strong>${escapeHtml(c.title)}</strong></td><td>${escapeHtml(user.name)}</td><td>${escapeHtml(c.frequency)}</td><td>${statusBadge(c.status)}</td><td>${formatDateCL(c.endDate)}</td></tr>`;
        }).join("");

    const overdue = tasks.filter(isOverdue).sort((a, b) => a.endDate.localeCompare(b.endDate));
    const overTbody = document.getElementById("report-overdue-tbody");
    overTbody.innerHTML = overdue.length === 0
      ? `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Sin tareas atrasadas en ${periodLabel()}.</td></tr>`
      : overdue.map(t => {
          const user = store.getUserById(t.assigneeId);
          return `<tr><td><strong>${escapeHtml(t.title)}</strong></td><td>${escapeHtml(user.name)}</td><td>${escapeHtml(t.priority)}</td><td>${statusBadge(t.status)}</td><td>${formatDateCL(t.endDate)}</td><td>${daysLate(t)}</td></tr>`;
        }).join("");

    const teamTbody = document.getElementById("report-team-tbody");
    const reportCargos = cargosForTasks(tasks);
    teamTbody.innerHTML = reportCargos.map(u => {
      const uTasks = tasks.filter(t => t.assigneeId === u.id);
      const uTotal = uTasks.length;
      const uComp = uTasks.filter(t => t.status === "Completada").length;
      const uProc = uTasks.filter(t => t.status === "En proceso").length;
      const uPend = uTasks.filter(t => t.status === "Pendiente").length;
      const uSusp = uTasks.filter(t => t.status === "Suspendida").length;
      const uPct = uTotal > 0 ? Math.round((uComp / uTotal) * 100) : 0;
      return `<tr><td><strong>${escapeHtml(cargoLabel(u))}</strong></td><td>${uTotal}</td><td>${uComp}</td><td>${uProc}</td><td>${uPend}</td><td>${uSusp}</td><td><strong>${uPct}%</strong></td></tr>`;
    }).join("");

    if (typeof Chart === "undefined") return;
    applyChartTheme();
    const ctx = document.getElementById("reportWorkloadChart").getContext("2d");
    if (reportWorkloadChart) reportWorkloadChart.destroy();
    reportWorkloadChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: reportCargos.map(u => cargoLabel(u)),
        datasets: [
          { label: "Total Tareas Asignadas", data: reportCargos.map(u => tasks.filter(t => t.assigneeId === u.id).length), backgroundColor: "#3b82f6", borderRadius: 4 },
          { label: "Tareas Completadas", data: reportCargos.map(u => tasks.filter(t => t.assigneeId === u.id && t.status === "Completada").length), backgroundColor: "#10b981", borderRadius: 4 }
        ]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: { font: { size: 11 } } } },
        scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
      }
    });
  }

  /* =========================================================
     INICIO
     ========================================================= */
  applyTheme(currentTheme(), false);
  populateAssignees();
  refreshAll();
  if (store.cargosMode === "fallback") {
    setSyncStatus("⚠ Cargos sin reglas (ver Administrar cargos)", "err");
  }

  // V3: cuando otro usuario cambia algo en la base compartida, se vuelve a dibujar la vista
  store.onChange = refreshAll;
};
