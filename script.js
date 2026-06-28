import { database } from './firebase-config.js';
import { ref, set, get, push, remove, update, onValue, onChildAdded, query, limitToLast } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

// --- FIREBASE DATABASE ---
const db = {
    get: async (key) => {
        const snapshot = await get(ref(database, key));
        return snapshot.exists() ? snapshot.val() : null;
    },
    set: (key, data) => set(ref(database, key), data),
    add: (collection, data) => {
        const newRef = push(ref(database, collection));
        set(newRef, data);
        return { id: newRef.key };
    },
    update: (path, newData) => update(ref(database, path), newData),
    delete: (path) => remove(ref(database, path)),
    onDataChange: (key, callback) => {
        onValue(ref(database, key), (snapshot) => {
            const data = snapshot.exists() ? snapshot.val() : {};
            callback(data);
        });
    }
};

// --- VARIABLES GLOBALES ---
let currentUser = null;
let members = [];
let products = [];
let finances = [];
let visits = [];
let trash = [];
let history = [];
let users = [];
let debts = []; // fiados / cuentas por cobrar
let cart = [];
let selectedMemberId = null;
// Foto del ranking (para las flechas de subió/bajó). Se guarda en Firebase 1 vez/día.
let rankingSnapshot = { date: null, positions: {} };
// Precios por defecto. Fuente de verdad real = Firebase (config/prices).
// Estos solo se usan si Firebase aun no tiene precios guardados.
const DEFAULT_PRICES = {
    "visit": 50, "weekly": 200, "biweekly": 350,
    "monthly": 500, "student": 400,
    "quarterly": 1200, "semiannual": 2200, "annual": 4000,
    "couple": 900, "family3": 1300, "family4": 1600
};
let prices = { ...DEFAULT_PRICES };

// Mapa llave -> id del input en la pantalla de Configuracion de Precios
const PRICE_INPUT_MAP = {
    "visit": "conf-visit", "weekly": "conf-weekly", "biweekly": "conf-biweekly",
    "monthly": "conf-monthly", "student": "conf-student",
    "quarterly": "conf-quarterly", "semiannual": "conf-semiannual", "annual": "conf-annual",
    "couple": "conf-couple", "family3": "conf-family3", "family4": "conf-family4"
};

// Refresca los inputs de la pantalla de precios con el objeto `prices` actual
function syncPriceInputs() {
    for (const [key, id] of Object.entries(PRICE_INPUT_MAP)) {
        const el = document.getElementById(id);
        if (el && prices[key] !== undefined) el.value = prices[key];
    }
}

// ===== ANTIGÜEDAD Y RACHAS (FLAMITA) =====
// Clave de fecha local 'YYYY-MM-DD'
function localDateKey(d) {
    const x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
// ¿Todos los días ESTRICTAMENTE entre aKey y bKey son fin de semana? (sáb/dom)
// Si hay un día entre semana sin asistir, la racha se rompe.
function gapIsOnlyWeekend(aKey, bKey) {
    const a = new Date(aKey + 'T00:00:00');
    const b = new Date(bKey + 'T00:00:00');
    const d = new Date(a); d.setDate(d.getDate() + 1);
    while (d < b) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) return false;
        d.setDate(d.getDate() + 1);
    }
    return true;
}
// Calcula racha actual y mejor racha a partir de fechas 'YYYY-MM-DD' con asistencia
function computeStreak(dateKeys) {
    const keys = Array.from(new Set(dateKeys)).sort();
    if (keys.length === 0) return { current: 0, best: 0, last: null };
    let best = 1, run = 1;
    for (let i = 1; i < keys.length; i++) {
        if (gapIsOnlyWeekend(keys[i - 1], keys[i])) run++; else run = 1;
        if (run > best) best = run;
    }
    let curRun = 1;
    for (let i = keys.length - 1; i > 0; i--) {
        if (gapIsOnlyWeekend(keys[i - 1], keys[i])) curRun++; else break;
    }
    const todayKey = localDateKey(new Date());
    const lastKey = keys[keys.length - 1];
    let current;
    if (lastKey === todayKey || gapIsOnlyWeekend(lastKey, todayKey)) current = curRun; // viva
    else current = 0; // faltó un día entre semana -> perdida
    return { current, best, last: lastKey };
}
// Antigüedad en texto legible
function tenureText(registeredAt) {
    if (!registeredAt) return '—';
    const r = new Date(registeredAt), now = new Date();
    let months = (now.getFullYear() - r.getFullYear()) * 12 + (now.getMonth() - r.getMonth());
    if (now.getDate() < r.getDate()) months--;
    if (months < 0) months = 0;
    const y = Math.floor(months / 12), m = months % 12;
    if (y > 0) return `${y} año${y === 1 ? '' : 's'}${m > 0 ? ' ' + m + ' mes' + (m === 1 ? '' : 'es') : ''}`;
    if (m > 0) return `${m} mes${m === 1 ? '' : 'es'}`;
    const days = Math.floor((now - r) / 86400000);
    return `${days} día${days === 1 ? '' : 's'}`;
}
// Antigüedad en meses (para ordenar/filtrar)
function tenureMonths(registeredAt) {
    if (!registeredAt) return 0;
    const r = new Date(registeredAt), now = new Date();
    let months = (now.getFullYear() - r.getFullYear()) * 12 + (now.getMonth() - r.getMonth());
    if (now.getDate() < r.getDate()) months--;
    return Math.max(0, months);
}
// Fechas de asistencia (visitas exitosas) de un socio por código
function memberAttendanceKeys(code) {
    return visits.filter(v => String(v.code) === String(code) && v.status === 'success').map(v => localDateKey(v.date));
}

// ===== LOGROS / INSIGNIAS =====
// Catálogo de insignias. `test` recibe el objeto de logros del socio.
const BADGES = [
    { key: 'week',    name: 'Primera semana', req: '7 días seguidos',            icon: 'ti-flame',          color: '#00ff41', test: a => a.best >= 7 },
    { key: 'const',   name: 'Constante',      req: '30 días seguidos',           icon: 'ti-calendar-stats', color: '#ffaa00', test: a => a.best >= 30 },
    { key: 'early',   name: 'Madrugador',     req: '10 entradas antes de 7am',   icon: 'ti-sunrise',        color: '#4488ff', test: a => a.early >= 10 },
    { key: 'unstop',  name: 'Imparable',      req: '100 días seguidos',          icon: 'ti-bolt',           color: '#aa44ff', test: a => a.best >= 100 },
    { key: 'weekend', name: 'Finde guerrero', req: '8 días de fin de semana',    icon: 'ti-barbell',        color: '#ff003c', test: a => a.weekendDays >= 8 },
    { key: 'legend',  name: 'Leyenda Atlas',  req: '365 días seguidos',          icon: 'ti-crown',          color: '#ffd700', test: a => a.best >= 365 }
];

// Logros de UN socio (para la ficha). Devuelve métricas para evaluar insignias.
function getMemberAchievements(code) {
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const keys = [];
    let early = 0;
    const weekend = new Set();
    const month = new Set();
    visits.forEach(v => {
        if (v.status !== 'success' || String(v.code) !== String(code)) return;
        const d = new Date(v.date);
        const k = localDateKey(d);
        keys.push(k);
        if (d.getHours() < 7) early++;
        const dow = d.getDay();
        if (dow === 0 || dow === 6) weekend.add(k);
        if (k.indexOf(ym) === 0) month.add(k);
    });
    const stk = computeStreak(keys);
    return { best: stk.best, current: stk.current, early, weekendDays: weekend.size, monthDays: month.size, totalVisits: keys.length };
}

// Índice de logros de TODOS los socios (1 sola pasada por visitas). Para la sección y el dashboard.
function buildAchievementsIndex() {
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const idx = {};
    visits.forEach(v => {
        if (v.status !== 'success') return;
        const c = String(v.code);
        let e = idx[c];
        if (!e) e = idx[c] = { keys: [], early: 0, weekend: new Set(), month: new Set() };
        const d = new Date(v.date);
        const k = localDateKey(d);
        e.keys.push(k);
        if (d.getHours() < 7) e.early++;
        const dow = d.getDay();
        if (dow === 0 || dow === 6) e.weekend.add(k);
        if (k.indexOf(ym) === 0) e.month.add(k);
    });
    return members.map(m => {
        const e = idx[String(m.code)] || { keys: [], early: 0, weekend: new Set(), month: new Set() };
        const stk = computeStreak(e.keys);
        return { m, best: stk.best, current: stk.current, early: e.early, weekendDays: e.weekend.size, monthDays: e.month.size, totalDays: new Set(e.keys).size };
    });
}

const PLAN_NAMES = {
    "visit": "Visita",
    "weekly": "Semanal",
    "biweekly": "Quincenal",
    "monthly": "Mensual",
    "student": "Estudiante",
    "quarterly": "Trimestral",
    "semiannual": "Semestral",
    "annual": "Anual",
    "couple": "Pareja",
    "family3": "Fam. (3 Pers)",
    "family4": "Fam. (4 Pers)"
};

// --- UI HELPERS ---
function showToast(type, msg) {
    // Buscar el contenedor o crearlo si no existe
    let box = document.getElementById('toast-container');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toast-container';
        document.body.appendChild(box);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    
    toast.innerHTML = `<i class="fas ${icon}"></i> ${msg}`;
    box.appendChild(toast);

    // Desvanecer y eliminar
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        toast.style.transition = '0.5s';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

function customConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirm');
        document.getElementById('confirm-title').innerText = title;
        document.getElementById('confirm-message').innerText = message;
        modal.style.display = 'flex';

        document.getElementById('confirm-ok').onclick = () => {
            modal.style.display = 'none';
            resolve(true);
        };
        document.getElementById('confirm-cancel').onclick = () => {
            modal.style.display = 'none';
            resolve(false);
        };
    });
}

function customPrompt(title, message, defaultValue = '', inputType = 'text') {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-prompt');
        document.getElementById('prompt-title').innerText = title;
        document.getElementById('prompt-message').innerText = message;
        const input = document.getElementById('prompt-input');
        input.value = defaultValue;
        input.type = inputType;
        modal.style.display = 'flex';
        input.focus();

        document.getElementById('prompt-ok').onclick = () => {
            modal.style.display = 'none';
            resolve(input.value);
        };
        document.getElementById('prompt-cancel').onclick = () => {
            modal.style.display = 'none';
            resolve(null);
        };
    });
}


// --- APLICACIÓN PRINCIPAL ---
window.app = {
    logAction: function(type, description) {
        db.add('history', {
            type: type,
            description: description,
            user: currentUser.username,
            date: new Date().toISOString()
        });
    },
    
    // 1. SESIÓN
    login: async function() {
        const u = document.getElementById('login-user').value.trim();
        const p = document.getElementById('login-pass').value.trim();
        if (!u || !p) return showToast('error', 'Campos vacíos');

        // Hardcoded admin/dev users
        if (u === 'admin' && p === 'AtlassCC') {
            this.setSession({ name: 'Administrador', role: 'admin', username: 'admin' });
            return;
        }
        if (u === 'MVD' && p === '270327') {
            this.setSession({ name: 'Developer', role: 'dev', username: 'MVD' });
            return;
        }

        // Database users
        const usersData = await db.get('users') || {};
        const userId = Object.keys(usersData).find(key => usersData[key].username === u && usersData[key].password === p);

        if (userId) {
            const foundUser = { id: userId, ...usersData[userId] };
            this.setSession(foundUser);
        } else {
            showToast('error', 'Credenciales incorrectas');
        }
    },

    setSession: function(user) {
        currentUser = user;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-container').removeAttribute('hidden');
        document.getElementById('user-display-name').innerText = user.name;
        document.getElementById('user-display-role').innerText = user.role.toUpperCase();

        const applyVisibility = (hiddenSections = []) => {
            // First, make all nav buttons visible
            document.querySelectorAll('.nav-btn').forEach(btn => btn.style.display = 'flex');

            // Then, hide the ones in the hiddenSections array
            hiddenSections.forEach(sectionId => {
                const navButton = document.querySelector(`.nav-btn[onclick="app.nav('${sectionId}')"]`);
                if (navButton) {
                    navButton.style.display = 'none';
                }
            });

            // Special handling for menus: if all children are hidden, hide the menu
            const adminMenu = document.getElementById('admin-menu');
            if (adminMenu) {
                const visibleAdminButtons = Array.from(adminMenu.querySelectorAll('.nav-btn')).filter(btn => btn.style.display !== 'none').length;
                if (visibleAdminButtons === 0) {
                    adminMenu.style.display = 'none';
                }
            }
        };

        // Set initial visibility based on role
        document.querySelectorAll('.admin-only').forEach(e => e.style.display = (user.role === 'admin' || user.role === 'dev') ? 'inline-block' : 'none');
        const adminMenu = document.getElementById('admin-menu');
        if (adminMenu) adminMenu.style.display = (user.role === 'admin' || user.role === 'dev') ? 'block' : 'none';
        const devMenu = document.getElementById('dev-menu');
        if (devMenu) devMenu.style.display = (user.role === 'dev') ? 'block' : 'none';
        
        // Apply section visibility from user profile
        applyVisibility(user.hiddenSections);

        showToast('success', `Bienvenido, ${user.name}`);
        this.init();

        // Listen for real-time updates if the user is from the database
        if (user.id) {
            db.onDataChange(`users/${user.id}`, (userData) => {
                // Handle force logout
                if (userData.forceLogout) {
                    db.update(`users/${user.id}`, { forceLogout: false }); // Reset the flag
                    alert('Your session has been terminated by a developer.');
                    this.logout();
                    return;
                }
                
                // Handle hidden sections update
                currentUser.hiddenSections = userData.hiddenSections || [];
                applyVisibility(currentUser.hiddenSections);
            });
        }
    },

    logout: function() { location.reload(); },

    // 2. INICIALIZACIÓN
    init: function() {
        this.loadConfig();

        // Real-time theme listener
        db.onDataChange('config/theme', (themeData) => {
            if (themeData && themeData.primaryColor) {
                document.documentElement.style.setProperty('--primary', themeData.primaryColor);
                const colorPicker = document.getElementById('dev-color-primary');
                if (colorPicker) {
                    colorPicker.value = themeData.primaryColor;
                }
            }
        });

        // Real-time GLOBAL BROADCAST listener
        db.onDataChange('config/broadcast', (data) => {
            const banner = document.getElementById('system-sys-banner');
            const msgEl = document.getElementById('sys-banner-msg');
            if (banner && msgEl) {
                if (data && data.message && String(data.message).trim() !== "") {
                    msgEl.innerText = data.message;
                    banner.style.display = 'flex';
                } else {
                    banner.style.display = 'none';
                }
            }
        });
        
        // Real-time PRICES listener — fuente unica de verdad = Firebase.
        // Mantiene `prices` y los inputs SIEMPRE sincronizados; nunca revierten solos.
        db.onDataChange('config/prices', (data) => {
            if (data && typeof data === 'object') {
                // Mezcla: defaults como base + lo guardado en Firebase encima.
                // Asi llaves nuevas (couple/family3...) nunca quedan en $0.
                prices = { ...DEFAULT_PRICES, ...data };
            } else {
                prices = { ...DEFAULT_PRICES };
            }
            syncPriceInputs();
            // Si hay un modal de precio abierto, refrescar su monto mostrado
            const regModal = document.getElementById('modal-register');
            if (regModal && regModal.style.display === 'flex') this.updateRegisterPrice();
            const renewModal = document.getElementById('modal-renew-pro');
            if (renewModal && renewModal.style.display === 'flex') this.updateRenewPrice();
        });

        // Foto del ranking de rachas (para las flechas subió/bajó)
        db.onDataChange('config/rankingSnapshot', (data) => {
            rankingSnapshot = (data && data.positions) ? data : { date: null, positions: {} };
        });

        // Hamburger Menu Logic
        const hamburger = document.getElementById('hamburger-menu');
        const sidebar = document.querySelector('.sidebar');
        if (hamburger && sidebar) {
            hamburger.addEventListener('click', () => {
                sidebar.classList.toggle('show');
            });
            // Close sidebar when a nav button is clicked on mobile
            sidebar.querySelectorAll('.nav-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (window.innerWidth <= 992) {
                        sidebar.classList.remove('show');
                    }
                });
            });
        }
        
        db.onDataChange('members', (data) => {
            members = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            this.autoPurgeOldInactive();
            this.renderMembers();
            this.calcStats();
            if (document.getElementById('view-logros')?.classList.contains('active')) this.renderLogros();
        });
        db.onDataChange('products', (data) => {
            products = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            this.renderStore();
        });
        db.onDataChange('finances', (data) => {
            finances = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            if (document.getElementById('view-finances').classList.contains('active')) this.loadFinances();
        });
        db.onDataChange('visits', (data) => {
            visits = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            this.calcStats();
            if (document.getElementById('view-logros')?.classList.contains('active')) this.renderLogros();
        });
        
        // Listener REAL-TIME para Alertas de Acceso (Req 2)
        // Se activa cuando se añade un nuevo nodo a 'visits'
        const visitsRef = ref(database, 'visits');
        // Limit to last 1 to avoid showing alerts for old visits on load, 
        // but since we want *new* ones, we can just check the timestamp or use onChildAdded
        // For simplicity and effectiveness in this SPA:
        let initialLoad = true;
        
        onValue(visitsRef, (snapshot) => {
             // This is handled by the main listener above for the array
             // We need a specific listener for new additions to trigger the UI
        });

        // Use onChildAdded for instant reaction
        // We need to ignore the initial batch
        const newVisitsQuery = query(visitsRef, limitToLast(1));
        
        onChildAdded(newVisitsQuery, (snapshot) => {
            const v = snapshot.val();
            if (!v) return;
            
            // Check if the visit is recent (within last 10 seconds) to avoid firing on page reload
            const visitTime = new Date(v.date).getTime();
            const now = new Date().getTime();
            if (now - visitTime < 10000) { 
               this.showAccessAlert(v);
            }
        });
        db.onDataChange('trash', (data) => {
            trash = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            if (document.getElementById('view-trash').classList.contains('active')) this.renderTrash();
        });
        db.onDataChange('history', (data) => {
            history = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            if (document.getElementById('view-history').classList.contains('active')) this.renderHistory();
        });
        db.onDataChange('users', (data) => {
            users = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            if (document.getElementById('view-admin').classList.contains('active')) this.loadEmployees();
        });
        db.onDataChange('debts', (data) => {
            debts = Object.entries(data).map(([id, value]) => ({ id, ...value }));
            if (document.getElementById('view-debts')?.classList.contains('active')) this.renderDebts();
            const md = document.getElementById('modal-member-detail');
            if (md && md.style.display === 'flex' && selectedMemberId) this.renderMemberDebts(selectedMemberId);
        });

        this.nav('dashboard');
        // Restore theme mode from localStorage
        const savedTheme = localStorage.getItem('atlas-theme-mode');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
            const btn = document.getElementById('btn-theme-toggle');
            if (btn) { btn.innerHTML = '<i class="fas fa-moon"></i> Modo Oscuro'; btn.title = 'Cambiar a Modo Oscuro'; }
        }
    },

    nav: function(viewId) {
        document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`view-${viewId}`);
        if(target) target.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const navBtn = document.querySelector(`.nav-btn[onclick="app.nav('${viewId}')"]`);
        if (navBtn) navBtn.classList.add('active');

        if(viewId === 'dashboard') this.calcStats();
        if(viewId === 'finances') this.loadFinances('default'); 
        if(viewId === 'admin') this.loadEmployees(); 
        if(viewId === 'trash') this.renderTrash();
        if(viewId === 'history') this.renderHistory();
        if(viewId === 'reports') this.reports.init();
        if(viewId === 'dev') this.dev.loadUsers();
        if(viewId === 'stats') this.renderStats();
        if(viewId === 'logros') this.renderLogros();
        if(viewId === 'debts') this.renderDebts();
    },

    // 2.5. ESTADÍSTICAS PRO
    statsPeriod: '6m',

    setStatsPeriod: function(period, ev) {
        this.statsPeriod = period;
        document.querySelectorAll('.stats-period-btn').forEach(b => b.classList.remove('active'));
        if (period !== 'custom' && ev && ev.currentTarget) ev.currentTarget.classList.add('active');
        this.renderStats();
    },

    getStatsRange: function() {
        const now = new Date();
        let end = new Date(); end.setHours(23, 59, 59, 999);
        let start;
        const p = this.statsPeriod;
        const som = (y, m) => { const d = new Date(y, m, 1); d.setHours(0, 0, 0, 0); return d; };
        if (p === 'thisMonth') start = som(now.getFullYear(), now.getMonth());
        else if (p === 'lastMonth') {
            start = som(now.getFullYear(), now.getMonth() - 1);
            end = new Date(now.getFullYear(), now.getMonth(), 0); end.setHours(23, 59, 59, 999);
        }
        else if (p === '3m') start = som(now.getFullYear(), now.getMonth() - 2);
        else if (p === '6m') start = som(now.getFullYear(), now.getMonth() - 5);
        else if (p === '12m') start = som(now.getFullYear(), now.getMonth() - 11);
        else if (p === 'thisYear') { start = new Date(now.getFullYear(), 0, 1); start.setHours(0, 0, 0, 0); }
        else if (p === 'all') start = new Date(2000, 0, 1);
        else if (p === 'custom') {
            const s = document.getElementById('stats-start').value;
            const e = document.getElementById('stats-end').value;
            start = s ? new Date(s + 'T00:00:00') : som(now.getFullYear(), now.getMonth() - 5);
            if (e) { end = new Date(e + 'T23:59:59'); }
        }
        else start = som(now.getFullYear(), now.getMonth() - 5);
        return { start, end };
    },

    isExpenseType: function(t) {
        const s = String(t).toLowerCase();
        return s === 'gasto' || s === 'salida' || s === 'egreso';
    },

    renderStats: function() {
        if (!app.charts) app.charts = {};
        if (typeof Chart === 'undefined') return;
        const isLight = document.body.classList.contains('light-mode');
        const gridColor = isLight ? '#e0e0e0' : '#222';
        const tickColor = isLight ? '#555' : '#888';
        const legendColor = isLight ? '#333' : '#fff';
        const C = { red: '#ff003c', green: '#00ff41', orange: '#ffaa00', blue: '#4488ff', purple: '#aa44ff', cyan: '#00e5ff' };

        const { start, end } = this.getStatsRange();
        const lbl = document.getElementById('stats-range-label');
        if (lbl) lbl.innerText = `${start.toLocaleDateString()} — ${end.toLocaleDateString()}`;
        const inRange = (d) => { const t = new Date(d).getTime(); return t >= start.getTime() && t <= end.getTime(); };

        const fVisits = visits.filter(v => v.date && inRange(v.date));
        const fFinances = finances.filter(f => f.date && inRange(f.date));
        const fMembersReg = members.filter(m => m.registeredAt && inRange(m.registeredAt));

        // ---- KPIs del periodo ----
        let income = 0, expense = 0, cash = 0, card = 0, incomeCount = 0;
        let incInscr = 0, incRenov = 0, incTienda = 0, incOtros = 0;
        const expenseByCat = {};
        fFinances.forEach(f => {
            const amt = Number(f.amount) || 0;
            if (this.isExpenseType(f.type)) {
                expense += amt;
                const cat = f.categoria || 'Sin categoría';
                expenseByCat[cat] = (expenseByCat[cat] || 0) + amt;
                return;
            }
            income += amt; incomeCount++;
            if (f.metodoPago === 'Tarjeta') card += amt; else cash += amt;
            const t = String(f.type).toLowerCase();
            const desc = String(f.desc || '').toLowerCase();
            if (t.includes('inscri') || t === 'registro') incInscr += amt;
            else if (t.includes('renov')) incRenov += amt;
            else if (t.includes('tienda') || t.includes('venta') || desc.includes('tienda')) incTienda += amt;
            else incOtros += amt;
        });
        const balance = income - expense;
        const ticket = incomeCount ? Math.round(income / incomeCount) : 0;
        const visitsOk = fVisits.filter(v => v.status === 'success').length;
        const today = new Date();
        const activeNow = members.filter(m => (new Date(m.expiryDate) - today) >= 0).length;

        const kpis = [
            { label: 'Ingresos', value: '$' + income.toLocaleString(), color: C.green, icon: 'fa-arrow-up' },
            { label: 'Gastos', value: '$' + expense.toLocaleString(), color: C.red, icon: 'fa-arrow-down' },
            { label: 'Balance', value: '$' + balance.toLocaleString(), color: balance >= 0 ? C.orange : C.red, icon: 'fa-scale-balanced' },
            { label: 'Ticket prom.', value: '$' + ticket.toLocaleString(), color: C.cyan, icon: 'fa-receipt' },
            { label: 'Movimientos', value: fFinances.length, color: C.blue, icon: 'fa-list' },
            { label: 'Nuevos socios', value: fMembersReg.length, color: C.purple, icon: 'fa-user-plus' },
            { label: 'Visitas', value: visitsOk, color: C.red, icon: 'fa-door-open' },
            { label: 'Socios activos', value: activeNow, color: C.green, icon: 'fa-id-card' }
        ];
        const kpiBox = document.getElementById('stats-kpis');
        if (kpiBox) {
            kpiBox.innerHTML = kpis.map(k => `
                <div class="stats-kpi-card" style="border-left:3px solid ${k.color};">
                    <div class="skc-icon" style="color:${k.color};"><i class="fas ${k.icon}"></i></div>
                    <div class="skc-body">
                        <div class="skc-value" style="color:${k.color};">${k.value}</div>
                        <div class="skc-label">${k.label}</div>
                    </div>
                </div>`).join('');
        }

        // ---- Agrupar por mes dentro del rango ----
        const monthKey = (d) => d.toLocaleString('es', { month: 'short' }) + ' ' + d.getFullYear();
        const months = {};
        let cur = new Date(start.getFullYear(), start.getMonth(), 1);
        const lastM = new Date(end.getFullYear(), end.getMonth(), 1);
        let guard = 0;
        while (cur <= lastM && guard < 36) {
            months[monthKey(cur)] = { income: 0, expense: 0, cash: 0, card: 0, regs: 0, sortDate: new Date(cur) };
            cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
            guard++;
        }
        const ensure = (d) => {
            const k = monthKey(d);
            if (!months[k]) months[k] = { income: 0, expense: 0, cash: 0, card: 0, regs: 0, sortDate: new Date(d.getFullYear(), d.getMonth(), 1) };
            return months[k];
        };
        fFinances.forEach(f => {
            const m = ensure(new Date(f.date)); const amt = Number(f.amount) || 0;
            if (this.isExpenseType(f.type)) m.expense += amt;
            else { m.income += amt; if (f.metodoPago === 'Tarjeta') m.card += amt; else m.cash += amt; }
        });
        fMembersReg.forEach(mem => { ensure(new Date(mem.registeredAt)).regs++; });
        const mKeys = Object.keys(months).sort((a, b) => months[a].sortDate - months[b].sortDate);

        // Guardar para exportar CSV
        this._statsCache = { start, end, income, expense, balance, cash, card, incInscr, incRenov, incTienda, incOtros, months, mKeys, visitsOk, newMembers: fMembersReg.length };

        const baseScales = {
            x: { ticks: { color: tickColor }, grid: { color: gridColor } },
            y: { ticks: { color: tickColor }, grid: { color: gridColor }, beginAtZero: true }
        };
        const mk = (id, cfg) => {
            const el = document.getElementById(id); if (!el) return;
            if (app.charts[id]) app.charts[id].destroy();
            app.charts[id] = new Chart(el, cfg);
        };

        // 1. Afluencia horaria
        const visitHours = new Array(24).fill(0);
        fVisits.forEach(v => visitHours[new Date(v.date).getHours()]++);
        mk('chart-visits', {
            type: 'line',
            data: { labels: Array.from({ length: 24 }, (_, i) => `${i}:00`), datasets: [{ label: 'Visitas', data: visitHours, backgroundColor: 'rgba(255,0,60,0.2)', borderColor: C.red, fill: true, tension: 0.4 }] },
            options: { responsive: true, plugins: { legend: { labels: { color: legendColor } } }, scales: baseScales }
        });

        // 2. Rendimiento mensual (ingresos vs gastos)
        mk('chart-finances', {
            type: 'bar',
            data: { labels: mKeys, datasets: [
                { label: 'Ingresos', data: mKeys.map(k => months[k].income), backgroundColor: C.green },
                { label: 'Gastos', data: mKeys.map(k => months[k].expense), backgroundColor: C.red }
            ] },
            options: { responsive: true, plugins: { legend: { labels: { color: legendColor } }, tooltip: { callbacks: { afterLabel: (ctx) => { if (ctx.dataset.label === 'Ingresos') { const m = months[mKeys[ctx.dataIndex]]; return ` (Efvo: $${m.cash.toLocaleString()} | Tarj: $${m.card.toLocaleString()})`; } return ''; } } } }, scales: baseScales }
        });

        // 3. Distribución por plan (foto actual)
        const planCounts = {};
        members.forEach(m => { const n = PLAN_NAMES[m.plan] || m.plan || 'Sin Plan'; planCounts[n] = (planCounts[n] || 0) + 1; });
        const planColors = ['#ff003c', '#ff4466', '#ff6680', '#ff8899', '#00ff41', '#00cc33', '#ffaa00', '#ff8800', '#4488ff', '#aa44ff', '#ff44aa'];
        mk('chart-plans', {
            type: 'doughnut',
            data: { labels: Object.keys(planCounts), datasets: [{ data: Object.values(planCounts), backgroundColor: planColors, borderColor: '#0a0a0a', borderWidth: 2 }] },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: tickColor, padding: 12, font: { size: 11 } } } } }
        });

        // 4. Visitas por día de la semana
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const dayVisits = new Array(7).fill(0);
        fVisits.forEach(v => { if (v.status === 'success') dayVisits[new Date(v.date).getDay()]++; });
        const maxDay = Math.max(...dayVisits);
        mk('chart-day-of-week', {
            type: 'bar',
            data: { labels: dayNames, datasets: [{ label: 'Visitas', data: dayVisits, backgroundColor: dayVisits.map(v => `rgba(255,0,60,${maxDay > 0 ? 0.3 + (v / maxDay) * 0.7 : 0.3})`), borderColor: C.red, borderWidth: 1, borderRadius: 6 }] },
            options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: tickColor }, grid: { display: false } }, y: baseScales.y } }
        });

        // 5. Tendencia de nuevos socios
        mk('chart-reg-trend', {
            type: 'line',
            data: { labels: mKeys, datasets: [{ label: 'Nuevos Socios', data: mKeys.map(k => months[k].regs), borderColor: C.orange, backgroundColor: 'rgba(255,170,0,0.1)', fill: true, tension: 0.4, pointBackgroundColor: C.orange, pointRadius: 4 }] },
            options: { responsive: true, plugins: { legend: { labels: { color: legendColor } } }, scales: { x: baseScales.x, y: { ticks: { color: tickColor, stepSize: 1 }, grid: { color: gridColor }, beginAtZero: true } } }
        });

        // 6. Tendencia de ingresos
        mk('chart-rev-trend', {
            type: 'line',
            data: { labels: mKeys, datasets: [{ label: 'Ingresos', data: mKeys.map(k => months[k].income), borderColor: C.green, backgroundColor: 'rgba(0,255,65,0.1)', fill: true, tension: 0.4, pointBackgroundColor: C.green, pointRadius: 4 }] },
            options: { responsive: true, plugins: { legend: { labels: { color: legendColor } }, tooltip: { callbacks: { label: (ctx) => 'Ingresos: $' + ctx.parsed.y.toLocaleString() } } }, scales: { x: baseScales.x, y: { ticks: { color: tickColor, callback: v => '$' + v.toLocaleString() }, grid: { color: gridColor }, beginAtZero: true } } }
        });

        // 7. NUEVA: Método de pago
        mk('chart-payment', {
            type: 'doughnut',
            data: { labels: ['Efectivo', 'Tarjeta'], datasets: [{ data: [cash, card], backgroundColor: [C.green, C.blue], borderColor: '#0a0a0a', borderWidth: 2 }] },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: tickColor } }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: $${ctx.parsed.toLocaleString()}` } } } }
        });

        // 8. NUEVA: Ingresos por tipo
        mk('chart-income-type', {
            type: 'bar',
            data: { labels: ['Inscripción', 'Renovación', 'Tienda', 'Otros'], datasets: [{ label: 'Ingresos', data: [incInscr, incRenov, incTienda, incOtros], backgroundColor: [C.red, C.orange, C.green, C.purple], borderRadius: 6 }] },
            options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => '$' + ctx.parsed.y.toLocaleString() } } }, scales: { x: baseScales.x, y: { ticks: { color: tickColor, callback: v => '$' + v.toLocaleString() }, grid: { color: gridColor }, beginAtZero: true } } }
        });

        // 9. NUEVA: Gastos por categoría
        const ecLabels = Object.keys(expenseByCat);
        const ecData = Object.values(expenseByCat);
        const ecColors = ['#ff003c', '#ffaa00', '#4488ff', '#aa44ff', '#00e5ff', '#ff6a00', '#00ff41', '#ff44aa', '#ffd700', '#cd7f32', '#888', '#c0c0c0'];
        mk('chart-expense-cat', {
            type: 'doughnut',
            data: { labels: ecLabels.length ? ecLabels : ['Sin gastos'], datasets: [{ data: ecData.length ? ecData : [1], backgroundColor: ecLabels.length ? ecColors : ['#222'], borderColor: '#0a0a0a', borderWidth: 2 }] },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: tickColor, padding: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: $${ctx.parsed.toLocaleString()}` } } } }
        });

        // 10. NUEVA: Ingresos vs Gastos del periodo
        mk('chart-inc-exp', {
            type: 'bar',
            data: { labels: ['Ingresos', 'Gastos', 'Balance'], datasets: [{ label: '$', data: [income, expense, income - expense], backgroundColor: [C.green, C.red, (income - expense) >= 0 ? C.orange : C.red], borderRadius: 6 }] },
            options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => '$' + ctx.parsed.y.toLocaleString() } } }, scales: { x: baseScales.x, y: { ticks: { color: tickColor, callback: v => '$' + v.toLocaleString() }, grid: { color: gridColor }, beginAtZero: true } } }
        });
    },

    exportStatsCSV: function() {
        const c = this._statsCache;
        if (!c) { showToast('error', 'Primero abre las estadísticas'); return; }
        const rows = [];
        rows.push(['ATLAS GYM - Estadisticas']);
        rows.push(['Periodo', c.start.toLocaleDateString(), 'a', c.end.toLocaleDateString()]);
        rows.push([]);
        rows.push(['Resumen', 'Valor']);
        rows.push(['Ingresos', c.income]);
        rows.push(['Gastos', c.expense]);
        rows.push(['Balance', c.balance]);
        rows.push(['Efectivo', c.cash]);
        rows.push(['Tarjeta', c.card]);
        rows.push(['Ingreso Inscripciones', c.incInscr]);
        rows.push(['Ingreso Renovaciones', c.incRenov]);
        rows.push(['Ingreso Tienda', c.incTienda]);
        rows.push(['Ingreso Otros', c.incOtros]);
        rows.push(['Visitas exitosas', c.visitsOk]);
        rows.push(['Nuevos socios', c.newMembers]);
        rows.push([]);
        rows.push(['Mes', 'Ingresos', 'Gastos', 'Efectivo', 'Tarjeta', 'Nuevos socios']);
        c.mKeys.forEach(k => { const m = c.months[k]; rows.push([k, m.income, m.expense, m.cash, m.card, m.regs]); });
        const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `atlas_estadisticas_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
        URL.revokeObjectURL(url);
        showToast('success', 'CSV exportado');
    },

    // 3. DASHBOARD
    calcStats: function() {
        this.renderDashLoyalty();
        this.renderDashConstancia();
        const today = new Date();
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const todayVisits = visits.filter(v => new Date(v.date) >= startOfDay && v.status === 'success');
        document.getElementById('stat-visits').innerText = todayVisits.length;

        let active=0, expiring=0, inactive=0;
        document.getElementById('bday-list').innerHTML = '';
        members.forEach(m => {
            const exp = new Date(m.expiryDate);
            const days = Math.ceil((exp - today)/(1000*60*60*24));
            if(days < 0) inactive++;
            else { active++; if(days <= 5) expiring++; }
            if(m.dob) {
                const [y, mo, d] = m.dob.split('-');
                if(Number(mo)-1 === today.getMonth()) {
                    document.getElementById('bday-list').innerHTML += `<li><i class="fas fa-caret-right"></i> <b>${d}</b> - ${m.name}</li>`;
                }
            }
        });
        document.getElementById('stat-active').innerText = active;
        document.getElementById('stat-expiring').innerText = expiring;
        const inactiveEl = document.getElementById('stat-inactive');
        const isHidden = inactiveEl.getAttribute('data-hidden') === 'true';
        inactiveEl.setAttribute('data-real-value', inactive);
        if (!isHidden) inactiveEl.innerText = inactive;

        // === ADVANCED DASHBOARD METRICS (Admin/Dev Only) ===
        const metricsPanel = document.getElementById('dashboard-advanced-metrics');
        if (metricsPanel && currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev')) {
            metricsPanel.style.display = 'block';
            const now = new Date();
            const thisMonth = now.getMonth();
            const thisYear = now.getFullYear();
            const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
            const lastMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;

            let revenueThisMonth = 0, revenueLastMonth = 0, storeRevenueThisMonth = 0;
            let newMembersThisMonth = 0, newMembersLastMonth = 0;
            let cashThisMonth = 0, cardThisMonth = 0;

            finances.forEach(f => {
                const d = new Date(f.date);
                const typeStr = String(f.type).toLowerCase();
                const isExpense = typeStr === 'gasto' || typeStr === 'salida' || typeStr === 'egreso';
                if (!isExpense) {
                    if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
                        const amt = Number(f.amount);
                        revenueThisMonth += amt;
                        if (f.metodoPago === 'Tarjeta') cardThisMonth += amt;
                        else cashThisMonth += amt;
                        if (typeStr === 'venta' || String(f.desc || '').toLowerCase().includes('venta tienda')) {
                            storeRevenueThisMonth += amt;
                        }
                    }
                    if (d.getMonth() === lastMonth && d.getFullYear() === lastMonthYear) {
                        revenueLastMonth += Number(f.amount);
                    }
                }
            });

            members.forEach(m => {
                if (!m.registeredAt) return;
                const regDate = new Date(m.registeredAt);
                if (regDate.getMonth() === thisMonth && regDate.getFullYear() === thisYear) newMembersThisMonth++;
                if (regDate.getMonth() === lastMonth && regDate.getFullYear() === lastMonthYear) newMembersLastMonth++;
            });

            const totalMembers = members.length;
            const retentionRate = totalMembers > 0 ? Math.round((active / totalMembers) * 100) : 0;
            const revenueChange = revenueLastMonth > 0
                ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
                : (revenueThisMonth > 0 ? 100 : 0);

            const planCount = {};
            members.forEach(m => { if (m.plan) planCount[m.plan] = (planCount[m.plan] || 0) + 1; });
            let topPlan = '-', topPlanCount = 0;
            for (const [plan, count] of Object.entries(planCount)) {
                if (count > topPlanCount) { topPlan = PLAN_NAMES[plan] || plan; topPlanCount = count; }
            }

            const avgRevenue = active > 0 ? Math.round(revenueThisMonth / active) : 0;

            const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
            setEl('metric-revenue', '$' + revenueThisMonth.toLocaleString());
            setEl('metric-revenue-change', (revenueChange >= 0 ? '+' : '') + revenueChange + '%');
            const chEl = document.getElementById('metric-revenue-change');
            if (chEl) chEl.style.color = revenueChange >= 0 ? 'var(--neon-green)' : 'var(--primary)';
            setEl('metric-new-members', newMembersThisMonth);
            const nmChange = newMembersLastMonth > 0 ? Math.round(((newMembersThisMonth - newMembersLastMonth) / newMembersLastMonth) * 100) : 0;
            setEl('metric-new-members-change', newMembersLastMonth > 0 ? (nmChange >= 0 ? '+' : '') + nmChange + '%' : 'N/A');
            const nmChEl = document.getElementById('metric-new-members-change');
            if (nmChEl) nmChEl.style.color = nmChange >= 0 ? 'var(--neon-green)' : 'var(--primary)';
            setEl('metric-retention', retentionRate + '%');
            setEl('metric-store-revenue', '$' + storeRevenueThisMonth.toLocaleString());
            setEl('metric-top-plan', topPlan);
            setEl('metric-avg-revenue', '$' + avgRevenue.toLocaleString());
            setEl('metric-cash-month', '$' + cashThisMonth.toLocaleString());
            setEl('metric-card-month', '$' + cardThisMonth.toLocaleString());
        } else if (metricsPanel) {
            metricsPanel.style.display = 'none';
        }
    },

    // 4. SOCIOS
    renderMembers: function(filter) {
        // Persistir el filtro actual para re-renders por búsqueda
        if (filter !== undefined) this._currentMemberFilter = filter;
        filter = this._currentMemberFilter || 'all';
        const tbody = document.getElementById('members-table-body');
        if(!tbody) return;
        tbody.innerHTML = '';
        
        const searchInput = document.getElementById('search-member');
        const search = searchInput ? searchInput.value.toLowerCase() : "";
        const today = new Date();
        let shownCount = 0;

        members.forEach(m => {
            const exp = new Date(m.expiryDate);
            const diffTime = exp - today;
            const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            let shouldShow = false;

            if (filter === 'all') {
                shouldShow = true;
            } else if (filter === 'active_only') {
                shouldShow = (days > 5);
            } else if (filter === 'expiring') {
                shouldShow = (days <= 5 && days >= 0);
            } else if (filter === 'inactive') {
                shouldShow = (days < 0);
            }
            else if (filter === 'visits_today') {
                const startOfDay = new Date();
                startOfDay.setHours(0, 0, 0, 0);
                shouldShow = visits.some(v => v.code === m.code && new Date(v.date) >= startOfDay);
            }

            const matchesSearch = m.name.toLowerCase().includes(search) || m.code.includes(search);

            if (shouldShow && matchesSearch) {
                shownCount++;
                let badge = "";
                if (days < 0) {
                    badge = `<span style="color:var(--primary); font-weight:bold;">VENCIDO</span>`;
                } else if (days <= 5) {
                    badge = `<span style="color:var(--neon-orange); font-weight:bold;">POR VENCER</span>`;
                } else {
                    badge = `<span style="color:var(--neon-green); font-weight:bold;">ACTIVO</span>`;
                }

                tbody.innerHTML += `
                    <tr>
                        <td style="color:var(--primary); font-weight:bold;">${m.code}</td>
                        <td style="font-weight:600;">${m.name}</td>
                        <td>${new Date(m.registeredAt).toLocaleDateString()}</td>
                        <td>${exp.toLocaleDateString()}</td>
                        <td>${badge}</td>
                        <td>
                            <button class="btn btn-outline" style="padding:5px 10px;" onclick="app.openMemberDetail('${m.id}')">
                                <i class="fas fa-eye"></i>
                            </button>
                        </td>
                    </tr>`;
            }
        });

        // ESTADO VACÍO PROFESIONAL
        if (shownCount === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align:center; padding:100px 20px; background: rgba(255,255,255,0.01);">
                        <div style="margin-bottom:20px;">
                            <i class="fas fa-users-slash" style="font-size:4rem; color:#222; text-shadow: 0 0 15px rgba(255,0,60,0.1);"></i>
                        </div>
                        <h2 style="font-family:'Rajdhani'; color:#555; letter-spacing:3px;">SIN SOCIOS</h2>
                        <p style="color:#444; margin-bottom:30px; text-transform:uppercase; font-size:0.8rem; letter-spacing:1px;">No se encontraron registros en esta categoría</p>
                        <button class="btn" onclick="app.filterMembers('all')" style="background:transparent; border:1px solid var(--primary); color:var(--primary); padding:12px 25px; cursor:pointer;">
                            <i class="fas fa-redo-alt"></i> VER TODA LA LISTA
                        </button>
                    </td>
                </tr>`;
        }

        const titleMap = { 
            'all': 'SOCIOS', 
            'active_only': 'SOCIOS ACTIVOS', 
            'expiring': 'SOCIOS POR VENCER', 
            'inactive': 'SOCIOS INACTIVOS',
            'visits_today': 'VISITAS DE HOY'
        };
        const viewTitle = document.querySelector('#view-members h1');
        if(viewTitle) viewTitle.innerText = titleMap[filter] || 'SOCIOS';

        // Mostrar/ocultar botón de eliminar inactivos
        const delInactiveBtn = document.getElementById('btn-delete-all-inactive');
        if (delInactiveBtn) {
            const canDelete = currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev');
            delInactiveBtn.style.display = (filter === 'inactive' && canDelete) ? 'inline-flex' : 'none';
        }
    },

    // ===== TOGGLE INACTIVOS OCULTAR/MOSTRAR =====
    toggleInactiveCount: function() {
        const el = document.getElementById('stat-inactive');
        const btn = document.getElementById('btn-toggle-inactive');
        if (!el) return;
        // Inicializar data-hidden si no existe
        if (!el.getAttribute('data-hidden')) el.setAttribute('data-hidden', 'false');
        const isHidden = el.getAttribute('data-hidden') === 'true';
        // Guardar valor real siempre que no esté oculto
        if (!isHidden) el.setAttribute('data-real-value', el.innerText);
        const realVal = el.getAttribute('data-real-value') || el.innerText;
        if (isHidden) {
            // Estaba oculto → mostrar
            el.innerText = realVal;
            el.setAttribute('data-hidden', 'false');
            if (btn) { btn.innerHTML = '<i class="fas fa-eye-slash"></i>'; btn.title = 'Ocultar número'; }
        } else {
            // Estaba visible → ocultar
            el.setAttribute('data-real-value', el.innerText);
            el.innerText = '***';
            el.setAttribute('data-hidden', 'true');
            if (btn) { btn.innerHTML = '<i class="fas fa-eye"></i>'; btn.title = 'Mostrar número'; }
        }
    },

    // ===== ELIMINAR TODOS LOS INACTIVOS =====
    deleteAllInactive: async function() {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acceso denegado');
        const today = new Date();
        const inactiveMembers = members.filter(m => (new Date(m.expiryDate) - today) < 0);
        if (inactiveMembers.length === 0) return showToast('error', 'No hay socios inactivos para eliminar');
        const confirmed = await customConfirm("Eliminar Todos los Inactivos", `¡ATENCIÓN! Esto moverá ${inactiveMembers.length} socio(s) inactivo(s) a la papelera. ¿Continuar?`);
        if (!confirmed) return;
        const password = await customPrompt("Confirmar Eliminación Masiva", "Ingrese la contraseña de ADMINISTRADOR:", '', 'password');
        if (password === 'AtlassCC') {
            inactiveMembers.forEach(m => {
                const memberData = { ...m, deletedAt: new Date().toISOString(), deletedBy: currentUser.username };
                db.set(`trash/${m.id}`, memberData);
                db.delete(`members/${m.id}`);
            });
            this.logAction('Eliminación Masiva Inactivos', `Se eliminaron ${inactiveMembers.length} socios inactivos.`);
            showToast('success', `${inactiveMembers.length} socios inactivos movidos a papelera`);
        } else if (password !== null) {
            showToast('error', 'Contraseña incorrecta. Acción cancelada.');
        }
    },

    // ===== MODO LIGHT/DARK =====
    toggleThemeMode: function() {
        const body = document.body;
        const isLight = body.classList.toggle('light-mode');
        const btn = document.getElementById('btn-theme-toggle');
        if (btn) {
            btn.innerHTML = isLight ? '<i class="fas fa-moon"></i> Modo Oscuro' : '<i class="fas fa-sun"></i> Modo Claro';
            btn.title = isLight ? 'Cambiar a Modo Oscuro' : 'Cambiar a Modo Claro';
        }
        localStorage.setItem('atlas-theme-mode', isLight ? 'light' : 'dark');
        // Re-renderizar gráficas si están visibles para actualizar colores
        const statsView = document.getElementById('view-stats');
        if (statsView && statsView.classList.contains('active')) {
            this.renderStats();
        }
    },


    filterMembers: function(type) { 
        this.nav('members'); 
        const searchInput = document.getElementById('search-member');
        if(searchInput) searchInput.value = ''; 
        this.renderMembers(type); 
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    // Añade esto para abrir el modal de registro
    openRegisterModal: function() {
        document.getElementById('modal-register').style.display = 'flex';
        // Reset to default
        document.getElementById('reg-plan').value = 'monthly';
        this.handlePlanChange();
    },

    handlePlanChange: function() {
        const plan = document.getElementById('reg-plan').value;
        const familyContainer = document.getElementById('family-size-container');
        let count = 1;

        if (plan === 'couple') {
            count = 2;
        } else if (plan === 'family3') {
            count = 3;
        } else if (plan === 'family4') {
            count = 4;
        }
        
        if (familyContainer) familyContainer.style.display = 'none';
        
        this.renderRegisterForms(count);
        this.updateRegisterPrice();
    },

    renderRegisterForms: function(count) {
        // Calculate count if not provided or if it's an event object
        if (typeof count !== 'number') {
            const plan = document.getElementById('reg-plan').value;
            if (plan === 'family3') {
                count = 3;
            } else if (plan === 'family4') {
                count = 4;
            } else if (plan === 'couple') {
                count = 2;
            } else {
                count = 1;
            }
        }

        const container = document.getElementById('reg-members-container');
        container.innerHTML = '';

        for (let i = 1; i <= count; i++) {
            const isMain = i === 1;
            const title = count > 1 ? `Socio #${i} ${isMain ? '(Titular)' : ''}` : 'Datos del Socio';
            
            container.innerHTML += `
                <div class="member-form-group" style="background: rgba(255,255,255,0.02); padding: 15px; border-radius: 8px; margin-bottom: 10px; border: 1px solid #333;">
                    <h4 style="color: var(--primary); margin-bottom: 10px; font-size: 0.9rem; text-transform: uppercase;">${title}</h4>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <input type="text" id="reg-name-${i}" placeholder="Nombre Completo *" style="grid-column: span 2">
                        <input type="text" id="reg-phone-${i}" placeholder="WhatsApp (52...) *">
                        <input type="date" id="reg-dob-${i}" title="Fecha Nacimiento">
                        <input type="email" id="reg-email-${i}" placeholder="Correo (Opcional)" style="grid-column: span 2">
                    </div>
                </div>
            `;
        }
        this.updateRegisterPrice();
    },

    updateRegisterPrice: function() {
        const plan = document.getElementById('reg-plan').value;
        let priceKey = plan;
        // family3/family4 are direct keys now
        const price = prices[priceKey] || 0;
        const display = document.getElementById('reg-price-display');
        if (display) {
            display.innerText = `$${price}`;
        }
    },

    confirmRegister: function() {
        const plan = document.getElementById('reg-plan').value;
        const paymentMethod = document.querySelector('input[name="reg-payment-method"]:checked').value;
        let count = 1;
        
        if (plan === 'couple') count = 2;
        else if (plan === 'family3') count = 3;
        else if (plan === 'family4') count = 4;

        const priceKey = plan;
        const price = prices[priceKey] || 0;
        const membersToRegister = [];

        // Validation Loop
        for (let i = 1; i <= count; i++) {
            const name = document.getElementById(`reg-name-${i}`).value.trim();
            const phone = document.getElementById(`reg-phone-${i}`).value.trim();
            
            if (!name || !phone) {
                return showToast('error', `Faltan datos del Socio #${i}`);
            }
            
            membersToRegister.push({
                name,
                phone,
                dob: document.getElementById(`reg-dob-${i}`).value,
                email: document.getElementById(`reg-email-${i}`).value
            });
        }

        // Calculate Expiry
        const exp = new Date();
        const planLower = plan.toLowerCase();
        
        // Logic for duration
        if (['visit'].includes(planLower)) exp.setDate(exp.getDate() + 1); // 1 Day (approx, or same day)
        else if (['weekly'].includes(planLower)) exp.setDate(exp.getDate() + 7);
        else if (['biweekly'].includes(planLower)) exp.setDate(exp.getDate() + 15);
        else if (['monthly', 'student', 'couple', 'family3', 'family4'].includes(planLower)) exp.setMonth(exp.getMonth() + 1);
        else if (planLower === 'quarterly') exp.setMonth(exp.getMonth() + 3);
        else if (planLower === 'semiannual') exp.setMonth(exp.getMonth() + 6);
        else if (planLower === 'annual') exp.setMonth(exp.getMonth() + 12);
        else exp.setMonth(exp.getMonth() + 1); // Default

        const transactionId = new Date().getTime(); // Simple ID for grouping
        const groupId = transactionId; // Use transactionId as the initial group ID
        const registeredAt = new Date().toISOString();
        const expiryDate = exp.toISOString();

        // Register Loop
        let mainMemberName = "";
        let mainMemberPhone = "";
        let mainMemberId = null;
        let mainMemberCode = "";
        let messagesToSend = [];

        membersToRegister.forEach((m, index) => {
            const code = Math.floor(10000 + Math.random() * 90000).toString();
            if (index === 0) {
                mainMemberName = m.name;
                mainMemberPhone = m.phone;
                mainMemberCode = code;
            }

            const newMember = {
                ...m,
                plan: plan, // Store the raw plan key
                code: code,
                expiryDate: expiryDate,
                registeredAt: registeredAt,
                registeredBy: currentUser.username,
                transactionId: transactionId,
                groupId: groupId // Persist group link
            };

            const _newRef = db.add("members", newMember);
            if (index === 0) mainMemberId = _newRef.id;

            // Prepare Professional Welcome Message
            const planName = PLAN_NAMES[plan] || plan.toUpperCase();
            const startDateStr = new Date(registeredAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
            const expiryDateStr = new Date(expiryDate).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
            const msg = `*ATLAS GYM*\n` +
                `━━━━━━━━━━━━━━━━━━━\n\n` +
                `¡Hola *${m.name}*! \n\n` +
                `¡Bienvenido(a) a la familia *ATLAS GYM*! Estamos emocionados de tenerte con nosotros.\n\n` +
                `\n*TU TARJETA DE SOCIO*\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                `Nombre: *${m.name}*\n` +
                `Codigo de Socio: *${code}*\n` +
                `Plan: *${planName}*\n` +
                `Inicio: *${startDateStr}*\n` +
                `Vence: *${expiryDateStr}*\n\n` +
                `Presenta tu codigo de socio para acceder al gimnasio.\n\n` +
                `━━━━━━━━━━━━━━━━━━━\n` +
                `*SIGUENOS EN REDES*\n` +
                `━━━━━━━━━━━━━━━━━━━\n\n` +
                `Instagram: https://www.instagram.com/atlasgym.fit?igsh=MXV5NnFuaWJpY3NuOQ==\n\n` +
                `TikTok: https://www.tiktok.com/@atlass2709?_r=1&_t=ZS-951vj3Li22p\n\n` +
                `━━━━━━━━━━━━━━━━━━━\n\n` +
                `Te gustaria formar parte de nuestra *comunidad de WhatsApp*? Responde *SI* y te agregamos!\n\n` +
                `¡Nos vemos en el gym!\n` +
                `*ATLAS GYM ― FORJA TU MEJOR VERSION*`;
            messagesToSend.push({ phone: m.phone, msg: msg, name: m.name, code: code });
        });

        // Finance Log (Single Entry)
        const displayPlan = PLAN_NAMES[plan] || plan.toUpperCase();
        if (paymentMethod === 'Fiado') {
            this.addDebt({ id: mainMemberId, name: mainMemberName, code: mainMemberCode }, `Inscripción ${displayPlan} (${count} socio${count === 1 ? '' : 's'})`, price, 'inscripcion');
        } else {
            this.addFinanceLog('INSCRIPCION', price, `Plan ${displayPlan} (${count} Socios) - Titular: ${mainMemberName}`, paymentMethod);
        }
        this.logAction('Registro Múltiple', `Se registraron ${count} socios bajo el plan ${displayPlan}. Pago: ${paymentMethod}.`);
        
        showToast('success', 'Registro exitoso');
        this.closeModal('modal-register');

        // WhatsApp FIRST — must open in direct user-click context (before print)
        // Browsers block window.open() inside setTimeout or after print dialogs
        // For family/couple plans, send at least to the first member (titular)
        if (messagesToSend.length > 0) {
            const first = messagesToSend[0];
            const waUrl = `https://wa.me/${first.phone}?text=${encodeURIComponent(first.msg)}`;
            window.open(waUrl, '_blank');
        }

        // Print receipt AFTER WhatsApp opens
        this.printReceipt(mainMemberName + (count > 1 ? ` (+${count-1})` : ''), price, `Membresía ${displayPlan}`);

        // Auto-download member cards (no popup needed)
        messagesToSend.forEach((item, i) => {
            setTimeout(() => {
                this.autoDownloadMemberCard(item.name, item.code, expiryDate);
            }, i * 1500);
        });
    },

    // Helper: Generate and auto-download a member card image (off-screen)
    autoDownloadMemberCard: function(name, code, expiryDate) {
        const tempCard = document.createElement('div');
        tempCard.id = 'temp-card-render';
        tempCard.style.cssText = 'position:fixed; left:-9999px; top:-9999px; z-index:-1;';
        tempCard.innerHTML = `
            <div class="member-card" style="width:400px; height:240px; background:linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 50%, #1a1a1a 100%); border-radius:16px; padding:25px; color:#fff; font-family:Rajdhani,sans-serif; position:relative; overflow:hidden; border:1px solid #333; box-shadow:0 10px 40px rgba(0,0,0,0.5);">
                <div style="position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg, transparent, #ff003c, transparent);"></div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <img src="Logo/ATLAS.png" style="height:40px; filter:drop-shadow(0 0 8px rgba(255,0,60,0.5));" crossorigin="anonymous">
                    <div style="width:35px; height:25px; background:linear-gradient(135deg, #ffcc00, #ff9900); border-radius:4px;"></div>
                </div>
                <div style="margin-bottom:15px;">
                    <small style="color:#ff003c; letter-spacing:3px; font-size:0.7rem; text-transform:uppercase;">Miembro Oficial</small>
                    <h2 style="margin:5px 0; font-size:1.4rem; font-weight:700; letter-spacing:1px; color:#fff;">${name}</h2>
                    <span style="font-size:2rem; font-weight:800; color:#ff003c; letter-spacing:4px; text-shadow:0 0 15px rgba(255,0,60,0.4);">${code}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #333; padding-top:10px; font-size:0.75rem; color:#888;">
                    <div>VENCE: ${new Date(expiryDate).toLocaleDateString('es-MX')}</div>
                    <div style="text-align:right; color:#aaa; letter-spacing:2px;">ATLAS GYM</div>
                </div>
            </div>
        `;
        document.body.appendChild(tempCard);

        const cardEl = tempCard.querySelector('.member-card');
        if (typeof html2canvas !== 'undefined') {
            html2canvas(cardEl, { backgroundColor: null, scale: 2 }).then(canvas => {
                const link = document.createElement('a');
                link.download = `tarjeta_${name.replace(/\s+/g, '_')}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
                tempCard.remove();
            }).catch(() => { tempCard.remove(); });
        } else {
            tempCard.remove();
        }
    },

    openMemberDetail: function(id) {
        selectedMemberId = id;
        const m = members.find(x => String(x.id) === String(id));
        if (!m) {
            showToast('error', 'Socio no encontrado, la lista se está actualizando.');
            return;
        }
        const modal = document.getElementById('modal-member-detail');
        modal.style.display = 'flex';
        
        const days = Math.ceil((new Date(m.expiryDate) - new Date())/(1000*60*60*24));
        const color = days < 0 ? 'var(--primary)' : (days<=5 ? 'var(--neon-orange)' : 'var(--neon-green)');
        
        // Buscar miembros del grupo
        let groupHtml = '';
        if (m.groupId) {
            const groupMembers = members.filter(gm => gm.groupId === m.groupId && gm.id !== m.id);
            if (groupMembers.length > 0) {
                const canEdit = (currentUser.role === 'admin' || currentUser.role === 'dev');
                const detachBtn = canEdit ? `
                    <button class="btn btn-outline" style="margin-top:10px; width:100%; font-size:0.8rem; padding:8px; border-color:var(--neon-orange); color:var(--neon-orange);" onclick="app.detachFromGroup()">
                        <i class="fas fa-user-minus"></i> Independizar a ${m.name.split(' ')[0]} del grupo
                    </button>
                ` : '';
                groupHtml = `
                    <div style="margin-top: 20px; background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 8px; border-left: 3px solid var(--neon-orange);">
                        <h4 style="margin:0 0 10px 0; color: #ddd; font-size: 0.9rem;"><i class="fas fa-users"></i> GRUPO VINCULADO (${groupMembers.length + 1})</h4>
                        <ul style="list-style: none; padding: 0; margin: 0; font-size: 0.85rem; color: #aaa;">
                            ${groupMembers.map(gm => `<li><i class="fas fa-user-circle"></i> ${gm.name} <small>(${gm.code})</small></li>`).join('')}
                        </ul>
                        ${detachBtn}
                    </div>
                `;
            }
        }

        document.getElementById('member-info-content').innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:start;">
                <div>
                    <h1 style="margin:0; font-size:2.5rem;">${m.name}</h1>
                    <p style="color:#888;">ID Sistema: ${m.id}</p>
                </div>
                <div style="text-align:right;">
                    <span style="font-size:3rem; font-family:'Rajdhani'; font-weight:800; color:var(--primary); line-height:1;">${m.code}</span>
                    <div style="background:${color}; color:#000; padding:2px 10px; border-radius:4px; font-weight:bold; font-size:0.8rem; margin-top:5px;">
                        ${days < 0 ? 'MEMBRESÍA EXPIRADA' : 'DÍAS RESTANTES: ' + days}
                    </div>
                </div>
            </div>
            ${groupHtml}
        `;

        // Antigüedad, racha (flamita) e insignias
        const _loyaltyEl = document.getElementById('member-loyalty-content');
        if (_loyaltyEl) {
            const _ach = getMemberAchievements(m.code);
            const _earned = BADGES.filter(b => b.test(_ach));
            const _chips = _earned.length
                ? `<div class="loyalty-chips">${_earned.map(b => `<span class="lb-chip" style="color:${b.color}; border-color:${b.color}66;"><i class="ti ${b.icon}"></i> ${b.name}</span>`).join('')}</div>`
                : `<div class="loyalty-chips"><span style="color:#555; font-size:0.8rem;"><i class="fas fa-lock" style="margin-right:5px;"></i>Sin insignias aún</span></div>`;
            _loyaltyEl.innerHTML = `
                <div class="loyalty-badges">
                    <div class="loyalty-badge"><i class="fas fa-medal" style="color:var(--neon-orange);"></i><div><b>${tenureText(m.registeredAt)}</b><small>Antigüedad</small></div></div>
                    <div class="loyalty-badge"><i class="fas fa-fire" style="color:#ff6a00;"></i><div><b>${_ach.current} día${_ach.current === 1 ? '' : 's'}</b><small>Racha actual</small></div></div>
                    <div class="loyalty-badge"><i class="fas fa-trophy" style="color:#ffd700;"></i><div><b>${_ach.best} día${_ach.best === 1 ? '' : 's'}</b><small>Mejor racha</small></div></div>
                </div>
                ${_chips}`;
        }
        this.renderMemberDebts(m.id);

        document.getElementById('edit-name').value = m.name;
        document.getElementById('edit-phone').value = m.phone || '';

        const allVisits = visits.filter(v => String(v.code) === String(m.code));
        const visitCount = allVisits.length;
        document.getElementById('visit-counter-badge').innerText = `${visitCount} VISITAS TOTALES`;

        const listContainer = document.getElementById('member-visits-list');
        listContainer.innerHTML = '';

        if(visitCount === 0) {
            listContainer.innerHTML = '<div style="padding:10px; text-align:center;">No se registran visitas aún.</div>';
        } else {
            allVisits.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach((v, index) => {
                const dateObj = new Date(v.date);
                const visitNumber = visitCount - index;
                listContainer.innerHTML += `
                    <div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #111;">
                        <span><b style="color:var(--primary)">#${visitNumber}</b> Visita</span>
                        <span>${dateObj.toLocaleDateString()}</span>
                        <span style="color:#fff;">${dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    </div>
                `;
            });
        }

        const inputs = modal.querySelectorAll('input');
        inputs.forEach(i => i.disabled = (currentUser.role !== 'admin' && currentUser.role !== 'dev'));
    },

    deleteMember: async function() {
        if(currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acceso denegado');
        
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        let groupMembers = [];
        let message = "Ingrese la contraseña de ADMINISTRADOR para eliminar este socio:";
        
        if (m.groupId) {
            groupMembers = members.filter(gm => gm.groupId === m.groupId);
            if (groupMembers.length > 1) {
                message = `¡ATENCIÓN! Este socio es parte de un grupo de ${groupMembers.length} personas. Al eliminarlo, SE ELIMINARÁ TODO EL GRUPO.\n\nIngrese contraseña para confirmar:`;
            } else {
                groupMembers = [m];
            }
        } else {
            groupMembers = [m];
        }

        const password = await customPrompt("Confirmar Eliminación", message, '', 'password');
        
        if(password === 'AtlassCC') {
            groupMembers.forEach(gm => {
                const memberData = { ...gm, deletedAt: new Date().toISOString(), deletedBy: currentUser.username };
                db.set(`trash/${gm.id}`, memberData);
                db.delete(`members/${gm.id}`);
            });

            this.logAction('Eliminación Socio', `Se eliminó al socio ${m.name} y su grupo (${groupMembers.length} miembros).`);
            showToast('success', `Socio y grupo (${groupMembers.length}) movidos a la papelera`);
            this.closeModal('modal-member-detail');
        } else if(password !== null) {
            showToast('error', 'Contraseña incorrecta. Acción cancelada.');
        }
    },

    showMemberCard: function() {
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        document.getElementById('member-card-ui').innerHTML = `
            <div class="card-header"><img src="Logo/ATLAS.png" class="card-logo"><div class="card-chip"></div></div>
            <div class="card-body"><small style="color:var(--primary); letter-spacing:2px;">MIEMBRO OFICIAL</small>
            <h2>${m.name}</h2><span class="card-code">${m.code}</span></div>
            <div class="card-footer"><div>VENCE: ${new Date(m.expiryDate).toLocaleDateString()}</div><div style="text-align:right;">ATLAS GYM TITAN</div></div>
        `;
        document.getElementById('modal-card').style.display = 'flex';
    },

    openRenewModal: function() {
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        let groupInfo = '';
        let isGroupRenewal = false;
        let groupMembers = [];

        // Check if member is part of a group
        if (m.groupId) {
            groupMembers = members.filter(gm => gm.groupId === m.groupId);
            if (groupMembers.length > 1) {
                isGroupRenewal = true;
                groupInfo = `
                    <div class="group-detected-banner">
                        <div class="gd-title"><i class="fas fa-users"></i> GRUPO DETECTADO (${groupMembers.length} personas)</div>
                        <div class="gd-members">Integrantes: ${groupMembers.map(gm => gm.name.split(' ')[0]).join(', ')}</div>
                    </div>
                `;
            }
        }

        document.getElementById('renew-member-info').innerHTML = `
            ${groupInfo}
            <h4 style="margin:0">${m.name} ${isGroupRenewal ? '(+ Grupo)' : ''}</h4>
            <small style="color:#aaa">Vencimiento actual: ${new Date(m.expiryDate).toLocaleDateString()}</small>
        `;

        const modeToggle = document.getElementById('renew-mode-toggle');
        const picker = document.getElementById('renew-individual-picker');
        const pickerList = document.getElementById('renew-individual-list');

        if (isGroupRenewal) {
            modeToggle.style.display = '';
            const groupRadio = document.querySelector('input[name="renew-mode"][value="group"]');
            if (groupRadio) groupRadio.checked = true;

            pickerList.innerHTML = groupMembers.map(gm => `
                <label class="renew-member-option">
                    <input type="radio" name="renew-individual-member" value="${gm.id}" ${String(gm.id) === String(m.id) ? 'checked' : ''}>
                    <div class="rmo-body">
                        <div class="rmo-name">${gm.name}</div>
                        <small class="rmo-meta">${gm.code} · Vence: ${new Date(gm.expiryDate).toLocaleDateString()}</small>
                    </div>
                </label>
            `).join('');
        } else {
            modeToggle.style.display = 'none';
            picker.style.display = 'none';
            pickerList.innerHTML = '';
        }

        // Store group state in the modal DOM for confirmRenewal to read
        const modalEl = document.getElementById('modal-renew-pro');
        modalEl.dataset.isGroup = isGroupRenewal;
        if (isGroupRenewal) {
            modalEl.dataset.groupId = m.groupId;
        } else {
            delete modalEl.dataset.groupId;
        }

        this.onRenewModeChange();
        modalEl.style.display = 'flex';
    },

    onRenewModeChange: function() {
        const modalEl = document.getElementById('modal-renew-pro');
        const isGroup = modalEl.dataset.isGroup === 'true';
        const select = document.getElementById('renew-plan-select');
        const optGroups = select.querySelectorAll('optgroup');
        const picker = document.getElementById('renew-individual-picker');

        const modeInput = document.querySelector('input[name="renew-mode"]:checked');
        const mode = isGroup ? (modeInput ? modeInput.value : 'group') : 'single';

        if (mode === 'group') {
            picker.style.display = 'none';
            optGroups.forEach(og => {
                og.style.display = (og.label === 'Grupales') ? '' : 'none';
            });
            const groupMembers = members.filter(gm => String(gm.groupId) === String(modalEl.dataset.groupId));
            const size = groupMembers.length;
            if (size === 2) select.value = 'couple';
            else if (size === 3) select.value = 'family3';
            else if (size >= 4) select.value = 'family4';
            else select.value = 'couple';
        } else if (mode === 'individual') {
            picker.style.display = '';
            optGroups.forEach(og => {
                og.style.display = (og.label === 'Grupales') ? 'none' : '';
            });
            if (['couple','family3','family4'].includes(select.value)) {
                select.value = 'monthly';
            }
        } else {
            // single (member is not part of a group): show all plans, default to monthly
            picker.style.display = 'none';
            optGroups.forEach(og => og.style.display = '');
            select.value = 'monthly';
        }

        this.updateRenewPrice();
    },

    updateRenewPrice: function() {
        const p = document.getElementById('renew-plan-select').value;
        const display = document.getElementById('renew-price-display');
        display.innerText = `$${prices[p] || 0}`;
    },

    confirmRenewal: function() {
        const plan = document.getElementById('renew-plan-select').value;
        const paymentMethod = document.querySelector('input[name="renew-payment-method"]:checked').value;
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        const modalEl = document.getElementById('modal-renew-pro');
        const isGroup = modalEl.dataset.isGroup === 'true';
        const groupId = modalEl.dataset.groupId;
        const modeInput = document.querySelector('input[name="renew-mode"]:checked');
        const renewMode = isGroup ? (modeInput ? modeInput.value : 'group') : 'single';

        // Determine which member is actually being renewed
        let primaryMember = m;
        if (renewMode === 'individual') {
            const picked = document.querySelector('input[name="renew-individual-member"]:checked');
            if (!picked) {
                showToast('error', 'Selecciona qué integrante renueva');
                return;
            }
            primaryMember = members.find(x => String(x.id) === String(picked.value)) || m;
            // Guard: individual mode must use a non-group plan
            if (['couple','family3','family4'].includes(plan)) {
                showToast('error', 'En renovación individual debes elegir un plan individual');
                return;
            }
        }

        // Calculate New Expiry based on the primary member
        let d = new Date(primaryMember.expiryDate);
        if (d < new Date()) d = new Date();

        const planLower = plan.toLowerCase();
        if (['visit'].includes(planLower)) d.setDate(d.getDate() + 1);
        else if (['weekly'].includes(planLower)) d.setDate(d.getDate() + 7);
        else if (['biweekly'].includes(planLower)) d.setDate(d.getDate() + 15);
        else if (['monthly', 'student', 'couple', 'family', 'family3', 'family4'].includes(planLower)) d.setMonth(d.getMonth() + 1);
        else if (planLower === 'quarterly') d.setMonth(d.getMonth() + 3);
        else if (planLower === 'semiannual') d.setMonth(d.getMonth() + 6);
        else if (planLower === 'annual') d.setMonth(d.getMonth() + 12);
        else d.setMonth(d.getMonth() + 1);

        const newExpiryISO = d.toISOString();
        const price = prices[plan] || 0;
        const displayPlan = PLAN_NAMES[plan] || plan.toUpperCase();
        let renewDescription = `Renovación ${displayPlan}`;
        let renewUser = primaryMember.name;

        if (renewMode === 'group' && isGroup && groupId) {
            // Bulk Update: renew all group members with the new group plan
            const groupMembers = members.filter(gm => String(gm.groupId) === String(groupId));
            groupMembers.forEach(gm => {
                db.update(`members/${gm.id}`, { expiryDate: newExpiryISO, plan: plan });
            });
            renewUser = `${primaryMember.name} + ${Math.max(0, groupMembers.length - 1)} miembros`;
            renewDescription += ` (Grupo: ${groupMembers.length} personas)`;
        } else if (renewMode === 'individual' && isGroup && groupId) {
            // Dissolve the group: only the chosen member renews under the chosen individual plan.
            // Every other group member keeps their current expiry but is detached from the group
            // so they become independent and can renew individually later.
            const groupMembers = members.filter(gm => String(gm.groupId) === String(groupId));
            groupMembers.forEach(gm => {
                if (String(gm.id) === String(primaryMember.id)) {
                    db.update(`members/${gm.id}`, { expiryDate: newExpiryISO, plan: plan, groupId: null });
                } else {
                    db.update(`members/${gm.id}`, { groupId: null });
                }
            });
            const others = groupMembers.filter(gm => String(gm.id) !== String(primaryMember.id));
            renewUser = primaryMember.name;
            renewDescription = `Renovación Individual ${displayPlan} (ex-grupo de ${groupMembers.length}; ${others.length} independizado${others.length === 1 ? '' : 's'})`;
        } else {
            // Single Update (member was never in a group)
            db.update(`members/${primaryMember.id}`, { expiryDate: newExpiryISO, plan: plan });
        }

        if (paymentMethod === 'Fiado') {
            this.addDebt({ id: primaryMember.id, name: primaryMember.name, code: primaryMember.code }, `Renovación ${displayPlan}`, price, 'renovacion');
        } else {
            this.addFinanceLog('RENOVACION', price, `Socio: ${renewUser}`, paymentMethod);
        }
        this.logAction('Renovación', `Se renovó - ${renewDescription}. Pago: ${paymentMethod}.`);

        showToast('success', 'Renovación exitosa');
        this.closeModal('modal-renew-pro');
        this.closeModal('modal-member-detail');

        // WhatsApp Renewal Message — BEFORE print, in user-click context
        const newExpiryStr = new Date(newExpiryISO).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
        const renewalMemberToNotify = primaryMember;

        const renewMsg = `*ATLAS GYM*\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `¡Hola *${renewalMemberToNotify.name}*! \n\n` +
            `Tu membresia ha sido *RENOVADA* exitosamente!\n\n` +
            `\n*DETALLES DE RENOVACION*\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `Nombre: *${renewalMemberToNotify.name}*\n` +
            `Codigo de Socio: *${renewalMemberToNotify.code}*\n` +
            `Plan: *${displayPlan}*\n` +
            `Nueva fecha de vencimiento: *${newExpiryStr}*\n\n` +
            `Tu codigo de socio sigue siendo el mismo. Sigue entrenando sin parar!\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `*SIGUENOS EN REDES*\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `Instagram: https://www.instagram.com/atlasgym.fit?igsh=MXV5NnFuaWJpY3NuOQ==\n\n` +
            `TikTok: https://www.tiktok.com/@atlass2709?_r=1&_t=ZS-951vj3Li22p\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `¡Nos vemos en el gym!\n` +
            `*ATLAS GYM ― FORJA TU MEJOR VERSION*`;

        // Open WhatsApp BEFORE print — stays in user-gesture context
        if (renewalMemberToNotify.phone) {
            const waUrl = `https://wa.me/${renewalMemberToNotify.phone}?text=${encodeURIComponent(renewMsg)}`;
            window.open(waUrl, '_blank');
        }

        // Print receipt AFTER WhatsApp opens
        this.printReceipt(renewUser, price, renewDescription);
    },

    downloadMemberCard: function() {
        const cardElement = document.getElementById('member-card-ui');
        const member = members.find(x => String(x.id) === String(selectedMemberId));
        if (!cardElement || !member) return;

        html2canvas(cardElement, {
            backgroundColor: null, // Transparent background
            scale: 2 // Higher resolution
        }).then(canvas => {
            const link = document.createElement('a');
            link.download = `tarjeta_${member.name.replace(/\s+/g, '_')}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    },

    saveMemberEdit: function() {
        if(currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acceso denegado');
        const member = members.find(x => String(x.id) === String(selectedMemberId));
        const newName = document.getElementById('edit-name').value;
        const newPhone = document.getElementById('edit-phone').value;
        db.update(`members/${selectedMemberId}`, { 
            name: newName,
            phone: newPhone 
        });
        this.logAction('Actualización Socio', `Se actualizaron los datos de ${member.name}.`);
        showToast('success', 'Datos actualizados');
    },

    detachFromGroup: async function() {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') {
            return showToast('error', 'Acceso denegado');
        }
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        if (!m || !m.groupId) {
            return showToast('error', 'Este socio no pertenece a un grupo');
        }
        const siblings = members.filter(gm => gm.groupId === m.groupId && gm.id !== m.id);
        if (siblings.length === 0) {
            return showToast('error', 'Este socio ya no tiene vínculos grupales');
        }

        const confirmed = await customConfirm(
            'Independizar del grupo',
            `Se quitará a "${m.name}" del grupo pareja/familia. ` +
            `Conservará su fecha de vencimiento actual y podrá renovar por su cuenta cuando lo desee. ` +
            `Los demás integrantes (${siblings.length}) seguirán vinculados entre sí.\n\n¿Continuar?`
        );
        if (!confirmed) return;

        const password = await customPrompt(
            'Confirmar con contraseña',
            'Ingrese la contraseña de ADMINISTRADOR para independizar a este socio:',
            '', 'password'
        );
        if (password !== 'AtlassCC') {
            return showToast('error', 'Contraseña incorrecta');
        }

        // Only remove the groupId from THIS member; do not touch siblings or any expiry dates.
        db.update(`members/${m.id}`, { groupId: null });
        this.logAction(
            'Independizar socio',
            `Se independizó a ${m.name} del grupo (quedan ${siblings.length} integrante${siblings.length === 1 ? '' : 's'} vinculados).`
        );
        showToast('success', `${m.name.split(' ')[0]} ya es socio independiente`);
        this.closeModal('modal-member-detail');
    },

    trashViewMode: 'members', // 'members' or 'finances'

    setTrashView: function(mode) {
        this.trashViewMode = mode;
        
        // Update Buttons
        document.getElementById('btn-trash-members').className = mode === 'members' ? 'btn active' : 'btn btn-outline';
        document.getElementById('btn-trash-finances').className = mode === 'finances' ? 'btn active' : 'btn btn-outline';

        this.renderTrash();
    },

    renderTrash: function() {
        const tbody = document.getElementById('trash-table-body');
        const thead = document.querySelector('#view-trash table thead tr');
        tbody.innerHTML = '';

        let filteredTrash = [];
        
        if (this.trashViewMode === 'members') {
            // Filter: Must have code OR objectType='member' (for backward compatibility, assume no amount = member)
            filteredTrash = trash.filter(item => item.code || item.objectType === 'member');
            
            thead.innerHTML = `
                <th>Nombre</th>
                <th>Código</th>
                <th>Eliminado por</th>
                <th>Fecha Elim.</th>
                <th style="text-align:right;">Acciones</th>
            `;
        } else {
            // Filter: Must have amount OR objectType='finance'
            filteredTrash = trash.filter(item => (item.amount !== undefined) || item.objectType === 'finance');
            
            thead.innerHTML = `
                <th>Fecha / Hora</th>
                <th>Concepto</th>
                <th>Monto</th>
                <th>Eliminado por</th>
                <th style="text-align:right;">Acciones</th>
            `;
        }

        if (filteredTrash.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:50px; color:#666;">La papelera está vacía.</td></tr>`;
            return;
        }

        filteredTrash.forEach(item => {
            const deletedDate = item.deletedAt ? new Date(item.deletedAt).toLocaleDateString() : 'N/A';
            
            if (this.trashViewMode === 'members') {
                tbody.innerHTML += `
                    <tr>
                        <td>${item.name}</td>
                        <td>${item.code}</td>
                        <td style="color:#aaa;">${item.deletedBy || 'N/A'}</td>
                        <td style="color:#aaa;">${deletedDate}</td>
                        <td style="text-align:right;">
                            <button class="btn btn-outline" style="border-color:var(--neon-green); color:var(--neon-green);" onclick="app.restoreMember('${item.id}')">
                                <i class="fas fa-undo-alt"></i> Restaurar
                            </button>
                            <button class="btn admin-only" style="background:#d32f2f;" onclick="app.purgeMember('${item.id}')">
                                <i class="fas fa-fire"></i> Purga
                            </button>
                        </td>
                    </tr>
                `;
            } else {
                const amountColor = (String(item.type).toLowerCase() === 'gasto' || String(item.type).toLowerCase() === 'egreso' || String(item.type).toLowerCase() === 'salida') ? 'var(--primary)' : 'var(--neon-green)';
                tbody.innerHTML += `
                    <tr>
                        <td style="font-size:0.85rem;">${new Date(item.date).toLocaleString()}</td>
                        <td>${item.desc}</td>
                        <td style="color:${amountColor}; font-weight:bold;">$${Number(item.amount).toLocaleString()}</td>
                        <td style="color:#aaa;">${item.deletedBy || 'N/A'}</td>
                        <td style="text-align:right;">
                            <button class="btn btn-outline" style="border-color:var(--neon-green); color:var(--neon-green);" onclick="app.restoreFinance('${item.id}')">
                                <i class="fas fa-undo-alt"></i> Restaurar
                            </button>
                            <button class="btn admin-only" style="background:#d32f2f;" onclick="app.purgeFinance('${item.id}')">
                                <i class="fas fa-fire"></i> Purga
                            </button>
                        </td>
                    </tr>
                `;
            }
        });
    },

    restoreMember: async function(id) {
        const confirmed = await customConfirm("Restaurar Socio", "¿Seguro que quieres restaurar este socio?");
        if (!confirmed) return;

        const memberToRestore = trash.find(m => m.id === id);

        if (memberToRestore) {
            // Remove trash-specific metadata
            const { objectType, deletedAt, deletedBy, ...cleanMember } = memberToRestore;
            
            db.set(`members/${id}`, cleanMember);
            db.delete(`trash/${id}`);
            
            this.logAction('Restauración Socio', `Se restauró al socio ${cleanMember.name} (${cleanMember.code}).`);
            showToast('success', 'Socio restaurado exitosamente.');
        } else {
            showToast('error', 'No se pudo encontrar al socio en la papelera.');
        }
    },

    purgeMember: async function(id) {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') {
            showToast('error', 'Acción no permitida.');
            return;
        }

        const confirmed = await customConfirm("Eliminación Permanente", "¡ATENCIÓN! Esta acción eliminará permanentemente al socio. ¿Estás seguro?");
        if (confirmed) {
            const memberToPurge = trash.find(m => m.id === id);
            db.delete(`trash/${id}`);
            
            this.logAction('Purga Socio', `Se eliminó permanentemente al socio ${memberToPurge.name} (${memberToPurge.code}).`);
            showToast('success', 'Socio eliminado permanentemente.');
        }
    },

    restoreFinance: async function(id) {
        const confirmed = await customConfirm("Restaurar Registro", "¿Seguro que quieres restaurar este registro financiero?");
        if (!confirmed) return;

        const itemToRestore = trash.find(m => m.id === id);

        if (itemToRestore) {
            const { objectType, deletedAt, deletedBy, ...cleanItem } = itemToRestore;
            db.set(`finances/${id}`, cleanItem);
            db.delete(`trash/${id}`);
            
            this.logAction('Restauración Finanzas', `Se restauró el registro: ${cleanItem.desc} ($${cleanItem.amount}).`);
            showToast('success', 'Registro restaurado exitosamente.');
        } else {
            showToast('error', 'No se pudo encontrar el registro.');
        }
    },

    purgeFinance: async function(id) {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') {
            showToast('error', 'Acción no permitida.');
            return;
        }

        const confirmed = await customConfirm("Eliminación Permanente", "¡ATENCIÓN! Esta acción eliminará permanentemente el registro. ¿Estás seguro?");
        if (confirmed) {
            const itemToPurge = trash.find(m => m.id === id);
            db.delete(`trash/${id}`);
            
            this.logAction('Purga Finanzas', `Se eliminó permanentemente el registro: ${itemToPurge.desc}.`);
            showToast('success', 'Registro eliminado permanentemente.');
        }
    },
    // 5. TIENDA 
    renderStore: function() {
        const grid = document.getElementById('store-grid');
        const searchInput = document.getElementById('search-prod');
        const search = searchInput ? searchInput.value.toLowerCase() : "";
        const category = document.getElementById('filter-category').value;
        if(!grid) return;
        grid.innerHTML = '';
        const filtered = products.filter(p => (category === 'all' || p.category === category) && p.name.toLowerCase().includes(search));
        filtered.forEach(p => {
            const isLow = p.stock <= 3;
            const isOut = p.stock <= 0;
            grid.innerHTML += `
                <div class="prod-item ${isOut ? 'out-of-stock' : ''}" onclick="${isOut ? '' : `app.addToCart('${p.id}')`}">
                    ${isOut ? '<div class="prod-badge-agotado">AGOTADO</div>' : ''}
                    <div class="prod-actions-overlay">
                        <button onclick="event.stopPropagation(); app.addStock('${p.id}')" class="btn-mini-stock" title="Reponer"><i class="fas fa-plus"></i></button>
                        ${(currentUser.role === 'admin' || currentUser.role === 'dev') ? `<button onclick="event.stopPropagation(); app.delProd('${p.id}')" class="btn-mini-del" title="Eliminar"><i class="fas fa-times"></i></button>` : ''}
                    </div>
                    <div class="prod-icon" style="color: ${isLow ? 'var(--neon-orange)' : 'var(--primary)'}"><i class="fas ${p.icon || 'fa-box'}"></i></div>
                    <span class="prod-category">${p.category || 'General'}</span>
                    <span class="prod-name">${p.name}</span>
                    <span class="prod-price">$${p.price}</span>
                    <span class="prod-stock ${isLow ? 'low' : ''}">Stock: ${p.stock}</span>
                </div>`;
        });
    },

    addToCart: function(id) {
        const p = products.find(x => String(x.id) === String(id));
        const inCart = cart.filter(item => item.id === id).length;
        if(p.stock > inCart) {
            cart.push({...p}); this.renderCart(); showToast('success', `Añadido: ${p.name}`);
        } else showToast('error', 'Límite de stock alcanzado');
    },

    renderCart: function() {
        const container = document.getElementById('cart-items');
        const totalEl = document.getElementById('cart-total');
        if(!container) return;
        container.innerHTML = ''; let total = 0;
        if(cart.length === 0) { container.innerHTML = '<p style="text-align:center; color:#666; padding:20px;">Vacío</p>'; totalEl.innerText = '0'; return; }
        const grouped = cart.reduce((acc, item) => { acc[item.id] = acc[item.id] || { ...item, qty: 0 }; acc[item.id].qty++; return acc; }, {});
        Object.values(grouped).forEach(item => {
            const subtotal = item.price * item.qty; total += subtotal;
            container.innerHTML += `<div style="display:flex; justify-content:space-between; align-items:center; background:#222; padding:10px; border-radius:8px; margin-bottom:8px; border-left:3px solid var(--primary);"><div><div style="font-weight:bold;">${item.name}</div><div style="font-size:0.8rem; color:#888;">${item.qty} x $${item.price}</div></div><div style="text-align:right;"><div style="color:var(--neon-green); font-weight:bold;">$${subtotal}</div><button onclick="app.removeFromCart('${item.id}')" style="background:none; border:none; color:#ff4444; cursor:pointer; font-size:0.8rem;">Quitar</button></div></div>`;
        });
        totalEl.innerText = total.toLocaleString();
    },

    removeFromCart: function(id) {
        const idx = cart.findIndex(item => item.id === id);
        if(idx > -1) { cart.splice(idx, 1); this.renderCart(); }
    },

    clearCart: function() { cart = []; this.renderCart(); },

    checkout: function() {
        if(cart.length === 0) return showToast('error', 'Vacío');
        const paymentMethod = document.querySelector('input[name="store-payment-method"]:checked').value;
        const total = cart.reduce((sum, item) => sum + item.price, 0);
        const grouped = cart.reduce((acc, item) => { acc[item.id] = (acc[item.id] || 0) + 1; return acc; }, {});

        if (paymentMethod === 'Fiado') { this.checkoutFiado(total, grouped); return; }

        Object.keys(grouped).forEach(id => {
            const p = products.find(x => x.id === id);
            db.update(`products/${id}`, { stock: p.stock - grouped[id] });
        });
        this.addFinanceLog('TIENDA', total, `Venta Tienda`, paymentMethod);
        this.logAction('Venta Tienda', `Se realizó una venta en la tienda por un total de $${total}. Pago: ${paymentMethod}.`);
        this.printReceipt("Público General", total, "Productos");
        this.clearCart();
        showToast('success', 'Venta exitosa');
    },

    openProductModal: function() { 
        document.getElementById('prod-name').value = '';
        document.getElementById('prod-price').value = '';
        document.getElementById('prod-stock').value = '';
        document.getElementById('modal-product').style.display = 'flex'; 
    },
    
    saveProduct: function() {
        const name = document.getElementById('prod-name').value, price = Number(document.getElementById('prod-price').value), stock = Number(document.getElementById('prod-stock').value), category = document.getElementById('prod-category').value, icon = document.getElementById('prod-icon').value;
        if(!name || price <= 0) return showToast('error', 'Inválido');
        db.add("products", { name, price, stock, category, icon });
        this.logAction('Creación Producto', `Se creó el producto ${name}.`);
        this.closeModal('modal-product');
        showToast('success', 'Creado');
    },
    
    delProd: async function(id) {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acción no permitida.');
        const confirmed = await customConfirm("Eliminar Producto", "¿Estás seguro de que quieres eliminar este producto?");
        if(confirmed) {
            const prod = products.find(p => String(p.id) === String(id));
            db.delete(`products/${id}`);
            this.logAction('Eliminación Producto', `Se eliminó el producto ${prod.name}.`);
            showToast('success', 'Eliminado');
        }
    },

    addStock: async function(id) {
        const qty = await customPrompt("Añadir Stock", "Cantidad a añadir:");
        if(qty && !isNaN(qty)) {
            const prod = products.find(p => String(p.id) === String(id));
            if(prod) {
                db.update(`products/${id}`, { stock: Number(prod.stock) + Number(qty) });
                this.logAction('Añadir Stock', `Se añadieron ${qty} unidades de ${prod.name}.`);
                showToast('success', 'Actualizado');
            }
        }
    },

    // 6. FINANZAS
    loadFinances: function(mode = 'default') {
        const list = document.getElementById('finances-list');
        const startInput = document.getElementById('filter-start');
        const endInput = document.getElementById('filter-end');
        const typeInput = document.getElementById('filter-type');
        const methodInput = document.getElementById('filter-method');
        const userInput = document.getElementById('filter-user'); 
        if(!list) return;
        const today = new Date();
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') {
            const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(today.getDate() - 2);

            startInput.valueAsDate = threeDaysAgo > firstDayOfMonth ? threeDaysAgo : firstDayOfMonth;
            endInput.valueAsDate = today;
            startInput.disabled = true; endInput.disabled = true;
        } else {
            startInput.disabled = false; endInput.disabled = false;
            if (mode === 'default' && !startInput.value) {
                const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
                startInput.valueAsDate = firstDay; endInput.valueAsDate = today;
            }
        }
        const startVal = startInput.value.split('-');
        const endVal = endInput.value.split('-');
        
        const startDate = new Date(startVal[0], startVal[1] - 1, startVal[2]);
        startDate.setHours(0, 0, 0, 0);
        
        const endDate = new Date(endVal[0], endVal[1] - 1, endVal[2]);
        endDate.setHours(23, 59, 59, 999);
        const filterType = typeInput.value;
        const filterMethod = methodInput ? methodInput.value : "all";
        const filterUser = userInput ? userInput.value : "all";
        let all = finances;
        if (userInput && (mode === 'default' || userInput.options.length <= 1)) {
            const uniqueUsers = [...new Set(all.map(f => f.user))];
            userInput.innerHTML = '<option value="all">Todos los Usuarios</option>';
            uniqueUsers.forEach(u => { userInput.innerHTML += `<option value="${u}">${u}</option>`; });
            userInput.value = filterUser;
        }
        const processed = all.map(f => {
            const typeStr = String(f.type).toLowerCase();
            const isExpense = typeStr === 'gasto' || typeStr === 'salida' || typeStr === 'egreso';
            return { ...f, isExpense, dateObj: new Date(f.date) };
        });
        const filtered = processed.filter(f => {
            const dateMatch = f.dateObj >= startDate && f.dateObj <= endDate;
            let typeMatch = true;
            if (filterType === 'ingreso') typeMatch = !f.isExpense;
            if (filterType === 'gasto') typeMatch = f.isExpense;
            let methodMatch = true;
            if (filterMethod !== 'all') methodMatch = (f.metodoPago === filterMethod);
            let userMatch = true;
            if (filterUser !== 'all') userMatch = f.user === filterUser;
            return dateMatch && typeMatch && methodMatch && userMatch;
        });
        filtered.sort((a,b) => b.dateObj - a.dateObj);
        let income = 0, expense = 0, cashTotal = 0, cardTotal = 0, html = '';
        filtered.forEach(f => {
            if(f.isExpense) {
                expense += Number(f.amount);
            } else {
                income += Number(f.amount);
                if (f.metodoPago === 'Tarjeta') cardTotal += Number(f.amount);
                else cashTotal += Number(f.amount); // Assume default is Cash if undefined for legacy
            }
            
            const amountColor = f.isExpense ? 'var(--primary)' : 'var(--neon-green)';
            const sign = f.isExpense ? '- ' : '+ ';
            const badgeClass = f.isExpense ? 'gasto' : 'ingreso';
            const metodoDisplay = f.metodoPago || 'N/A';
            
            html += `<tr><td style="font-size:0.85rem; color:#888;">${f.dateObj.toLocaleDateString()} <br> <small>${f.dateObj.toLocaleTimeString()}</small></td><td><span class="badge-fin ${badgeClass}">${f.type}</span></td><td style="font-weight:600; color:#fff;">${f.categoria ? `<span style="display:inline-block; background:rgba(255,170,0,0.12); color:var(--neon-orange); font-size:0.68rem; padding:2px 8px; border-radius:10px; margin-right:6px; vertical-align:middle;">${f.categoria}</span>` : ''}${f.desc}</td><td style="color:#aaa;">${f.user}</td><td style="color:#aaa;">${metodoDisplay}</td><td style="font-family:'Rajdhani'; font-size:1.1rem; font-weight:bold; color:${amountColor}">${sign}$${Number(f.amount).toLocaleString()}</td><td style="text-align:right">${(currentUser.role === 'admin' || currentUser.role === 'dev') ? `<button onclick="app.delFin('${f.id}')" style="color:#666; background:none; border:none; cursor:pointer;"><i class="fas fa-trash"></i></button>` : ''}</td></tr>`;
        });
        list.innerHTML = html || '<tr><td colspan="7" style="text-align:center; padding:20px; color:#666;">Sin movimientos</td></tr>';
        
        document.getElementById('fin-total-income').innerHTML = `$${income.toLocaleString()}<br><span style="font-size:0.8rem; color:#888;">Efectivo: $${cashTotal.toLocaleString()} | Tarjeta: $${cardTotal.toLocaleString()}</span>`;
        document.getElementById('fin-total-expense').innerText = `$${expense.toLocaleString()}`;
        const balance = income - expense;
        const balEl = document.getElementById('fin-balance');
        if(balEl) { balEl.innerText = `$${balance.toLocaleString()}`; balEl.style.color = balance >= 0 ? 'var(--neon-orange)' : 'var(--primary)'; }
    },

    addFinanceLog: function(type, amount, desc, metodoPago = 'N/A', categoria = null) {
        if(!amount || isNaN(amount)) return;
        const rec = { type, amount: Number(amount), desc, user: currentUser.username, date: new Date().toISOString(), metodoPago };
        if (categoria) rec.categoria = categoria;
        db.add("finances", rec);
        if(document.getElementById('view-finances').classList.contains('active')) this.loadFinances();
    },

    openExpenseModal: function() { document.getElementById('modal-expense').style.display = 'flex'; },
    saveExpense: function() {
        const desc = document.getElementById('exp-desc').value, amount = document.getElementById('exp-amount').value;
        const catEl = document.getElementById('exp-category');
        const categoria = catEl ? catEl.value : 'Otro';
        if(!desc || !amount) return showToast('error', 'Incompleto');
        this.addFinanceLog('gasto', amount, desc, 'N/A', categoria);
        this.logAction('Registro Gasto', `Gasto de $${amount} (${categoria}): "${desc}".`);
        showToast('success', 'Registrado');
        this.closeModal('modal-expense');
    },
    delFin: async function(id) {
        if(currentUser.role !== 'admin' && currentUser.role !== 'dev') return;
        const confirmed = await customConfirm("Eliminar Registro", "¿Estás seguro de que quieres eliminar este registro financiero?");
        if(confirmed) { 
            const fin = finances.find(f => f.id === id);
            if (fin) {
                const trashData = { 
                    ...fin, 
                    objectType: 'finance', 
                    deletedAt: new Date().toISOString(), 
                    deletedBy: currentUser.username 
                };
                db.set(`trash/${id}`, trashData);
                db.delete(`finances/${id}`);
                this.logAction('Eliminación Finanzas', `Se eliminó el registro financiero "${fin.desc}" de $${fin.amount}.`);
                showToast('success', 'Movido a la papelera');
            }
        }
    },

    // 7. IMPRESIÓN PROFESIONAL.
    printReport: function() {
        const startVal = document.getElementById('filter-start').value;
        const endVal = document.getElementById('filter-end').value;
        if (!startVal || !endVal) { showToast('error', 'Seleccione fechas'); return; }

        const startDate = new Date(startVal); startDate.setHours(0,0,0,0);
        const endDate = new Date(endVal); endDate.setHours(23,59,59,999);

        const filtered = finances.map(f => {
            const typeStr = String(f.type).toLowerCase();
            const isExpense = typeStr === 'gasto' || typeStr === 'salida' || typeStr === 'egreso';
            return { ...f, isExpense, dateObj: new Date(f.date) };
        }).filter(f => f.dateObj >= startDate && f.dateObj <= endDate)
          .sort((a,b) => b.dateObj - a.dateObj);

        let income = 0, expense = 0, cashTotal = 0, cardTotal = 0;
        let inscripciones = 0, renovaciones = 0, ventasTienda = 0;

        let rowsHTML = '';
        filtered.forEach(f => {
            const amt = Number(f.amount);
            if (f.isExpense) { expense += amt; }
            else {
                income += amt;
                if (f.metodoPago === 'Tarjeta') cardTotal += amt; else cashTotal += amt;
            }
            const t = String(f.type).toLowerCase();
            if (t.includes('inscri') || t === 'registro') inscripciones++;
            else if (t.includes('renov')) renovaciones++;
            else if (t.includes('tienda') || t.includes('venta')) ventasTienda++;

            let bc = 'rpt-badge ';
            if (t.includes('inscri') || t === 'registro') bc += 'rpt-badge-inscripcion';
            else if (t.includes('renov')) bc += 'rpt-badge-renovacion';
            else if (t.includes('tienda') || t.includes('venta')) bc += 'rpt-badge-tienda';
            else if (f.isExpense) bc += 'rpt-badge-gasto';
            else bc += 'rpt-badge-ingreso';

            const ac = f.isExpense ? 'rpt-amount-negative' : 'rpt-amount-positive';
            const sign = f.isExpense ? '-' : '+';
            rowsHTML += '<tr>'
                + '<td>' + f.dateObj.toLocaleDateString('es-MX') + '</td>'
                + '<td>' + f.dateObj.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) + '</td>'
                + '<td><span class="' + bc + '">' + f.type + '</span></td>'
                + '<td>' + (f.categoria ? '[' + f.categoria + '] ' : '') + (f.desc || '') + '</td>'
                + '<td>' + (f.user || '') + '</td>'
                + '<td>' + (f.metodoPago || 'N/A') + '</td>'
                + '<td class="' + ac + '">' + sign + '$' + amt.toLocaleString() + '</td>'
                + '</tr>';
        });

        const balance = income - expense;
        const uniqueUsers = [...new Set(filtered.map(f => f.user))];

        const printHTML = '<div class="atlas-report">'
            + '<header class="atlas-report-header">'
            + '<div class="atlas-report-header-left">'
            + '<img src="Logo/ATLAS.png" alt="Atlas Gym">'
            + '<div><h1>ATLAS GYM - REPORTE DE CAJA</h1>'
            + '<p>Periodo: ' + startVal + ' al ' + endVal + '</p></div></div>'
            + '<div class="atlas-report-meta">'
            + '<p>Generado: ' + new Date().toLocaleString('es-MX') + '</p>'
            + '<p>Usuario: ' + currentUser.name + '</p></div></header>'
            + '<div class="atlas-report-kpis">'
            + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Total Ingresos</span><span class="atlas-kpi-value" style="color:#2e7d32">$' + income.toLocaleString() + '</span></div>'
            + '<div class="atlas-kpi"><span class="atlas-kpi-label">Total Gastos</span><span class="atlas-kpi-value" style="color:#c62828">$' + expense.toLocaleString() + '</span></div>'
            + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Balance Neto</span><span class="atlas-kpi-value">$' + balance.toLocaleString() + '</span></div>'
            + '<div class="atlas-kpi"><span class="atlas-kpi-label">Efectivo</span><span class="atlas-kpi-value">$' + cashTotal.toLocaleString() + '</span></div>'
            + '<div class="atlas-kpi"><span class="atlas-kpi-label">Tarjeta</span><span class="atlas-kpi-value">$' + cardTotal.toLocaleString() + '</span></div>'
            + '</div>'
            + '<table class="atlas-report-table"><thead><tr>'
            + '<th>Fecha</th><th>Hora</th><th>Tipo</th><th>Concepto</th><th>Usuario</th><th>Método</th><th>Monto</th>'
            + '</tr></thead><tbody>' + rowsHTML + '</tbody></table>'
            + '<div class="atlas-report-summary">'
            + '<div class="atlas-summary-item"><span class="atlas-summary-label">Movimientos</span><span class="atlas-summary-value">' + filtered.length + '</span></div>'
            + '<div class="atlas-summary-item"><span class="atlas-summary-label">Inscripciones</span><span class="atlas-summary-value">' + inscripciones + '</span></div>'
            + '<div class="atlas-summary-item"><span class="atlas-summary-label">Renovaciones</span><span class="atlas-summary-value">' + renovaciones + '</span></div>'
            + '<div class="atlas-summary-item"><span class="atlas-summary-label">Ventas Tienda</span><span class="atlas-summary-value">' + ventasTienda + '</span></div>'
            + '<div class="atlas-summary-item"><span class="atlas-summary-label">Usuarios</span><span class="atlas-summary-value">' + uniqueUsers.length + '</span></div>'
            + '</div>'
            + '<footer class="atlas-report-footer">'
            + '<span class="atlas-report-footer-note">' + filtered.length + ' registros procesados.</span>'
            + '<span>Atlas Gym - Sistema de Gestión</span>'
            + '</footer></div>';

        document.getElementById('printable-area').innerHTML = printHTML;
        window.print();
    },


    printReceipt: function(cliente, monto, concepto) {
        const ticketHTML = `<div class="receipt-print"><img src="Logo/ATLAS.png" style="width:60px; filter:grayscale(100%); margin-bottom:10px;"><h3>ATLAS GYM</h3><p>Recibo Oficial</p><p>${new Date().toLocaleString()}</p><br><div style="text-align:left; border-top:1px dashed #000; padding-top:10px;"><p><strong>Socio:</strong> ${cliente}</p><p><strong>Concepto:</strong> ${concepto}</p></div><div class="receipt-total">TOTAL: $${monto}</div><p><small>Atiende: ${currentUser.username}</small></p><p style="margin-top:10px; font-size:0.8rem;">¡Entrena con fuerza!</p></div>`;
        document.getElementById('printable-area').innerHTML = ticketHTML; window.print(); 
    },

    showAccessAlert: function(visit) {
        const overlay = document.getElementById('big-alert');
        const icon = document.getElementById('ba-icon');
        const title = document.getElementById('ba-title');
        const name = document.getElementById('ba-name');
        const reason = document.getElementById('ba-reason');
        
        if (!overlay) return;

        // Reset classes
        overlay.classList.remove('alert-success', 'alert-error');
        reason.style.display = 'none';

        name.innerText = visit.name;

        if (visit.status === 'success') {
            overlay.classList.add('alert-success');
            icon.innerHTML = '<i class="fas fa-check-circle"></i>';
            title.innerText = '¡BIENVENIDO!';
        } else {
            overlay.classList.add('alert-error');
            icon.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
            title.innerText = 'ACCESO DENEGADO';
            reason.innerText = visit.reason || 'Error Desconocido';
            reason.style.display = 'inline-block';
        }

        // Show
        overlay.classList.add('visible');

        // Auto hide after 4 seconds
        if (this.alertTimeout) clearTimeout(this.alertTimeout);
        this.alertTimeout = setTimeout(() => {
            overlay.classList.remove('visible');
        }, 4000);
    },

    // 8. OTROS
    loadConfig: async function() {
        // Lectura inicial. El listener realtime de init() mantiene esto sincronizado,
        // pero este fetch llena los inputs lo antes posible al entrar.
        try {
            const c = await db.get('config/prices');
            prices = (c && typeof c === 'object') ? { ...DEFAULT_PRICES, ...c } : { ...DEFAULT_PRICES };
        } catch (e) {
            prices = { ...DEFAULT_PRICES };
        }
        syncPriceInputs();
    },

    saveConfig: async function() {
        // Construye el nuevo objeto a partir de los inputs, pero de forma SEGURA:
        // si un input esta vacio o invalido, conserva el precio actual (no lo pone en 0).
        const newPrices = { ...prices };
        let invalid = 0;
        for (const [key, id] of Object.entries(PRICE_INPUT_MAP)) {
            const el = document.getElementById(id);
            if (!el) continue;
            const raw = el.value.trim();
            if (raw === '') continue;                 // vacio -> conservar actual
            const num = Number(raw);
            if (isNaN(num) || num < 0) { invalid++; continue; }
            newPrices[key] = num;
        }

        try {
            await db.set('config/prices', newPrices);   // Firebase = fuente de verdad
            prices = newPrices;
            syncPriceInputs();
            this.logAction('Config Precios', 'Se actualizaron los precios de los planes.');
            if (invalid > 0) {
                showToast('error', `Guardado, pero ${invalid} campo(s) invalido(s) se ignoraron`);
            } else {
                showToast('success', 'Precios guardados en la nube');
            }
        } catch (e) {
            showToast('error', 'No se pudo guardar. Revisa tu conexion.');
        }
    },

    // === RESPALDO: exportar toda la base de datos a un archivo JSON ===
    exportBackup: async function() {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') {
            return showToast('error', 'Acceso denegado');
        }
        try {
            showToast('success', 'Generando respaldo...');
            const all = await db.get('/') || {};
            const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            a.href = url;
            a.download = `atlas_respaldo_${stamp}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.logAction('Respaldo', 'Se exporto un respaldo completo de la base de datos.');
        } catch (e) {
            showToast('error', 'No se pudo generar el respaldo');
        }
    },

    // === LIBERAR ESPACIO: eliminar socios con +3 meses vencidos (PERMANENTE) ===
    purgeOldInactive: async function() {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acceso denegado');
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 3); // vencidos hace más de 3 meses
        const old = members.filter(m => m.expiryDate && new Date(m.expiryDate) < cutoff);
        if (old.length === 0) return showToast('error', 'No hay socios con más de 3 meses de vencidos');

        const confirmed = await customConfirm(
            'Liberar espacio',
            `Se eliminarán PERMANENTEMENTE ${old.length} socio(s) cuya membresía venció hace más de 3 meses. ` +
            `Esta acción NO se puede deshacer (no van a la papelera). ¿Continuar?`
        );
        if (!confirmed) return;

        const password = await customPrompt('Confirmar eliminación', 'Contraseña de ADMINISTRADOR:', '', 'password');
        if (password !== 'AtlassCC') {
            if (password !== null) showToast('error', 'Contraseña incorrecta');
            return;
        }

        old.forEach(m => db.delete(`members/${m.id}`));
        this.logAction('Limpieza Inactivos', `Se eliminaron permanentemente ${old.length} socios con +3 meses de inactividad.`);
        showToast('success', `${old.length} socios eliminados. Espacio liberado.`);
    },

    // Limpieza AUTOMÁTICA: borra socios vencidos hace +3 meses al cargar (1 vez por sesión)
    autoPurgeOldInactive: function() {
        if (this._autoCleanupDone) return;
        if (!members.length) return;               // esperar a que carguen los datos
        if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'dev')) return; // solo admin/dev
        this._autoCleanupDone = true;              // correr 1 sola vez por sesión

        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 3);
        const old = members.filter(m => m.expiryDate && new Date(m.expiryDate) < cutoff);
        if (old.length === 0) return;

        // Salvaguarda: si se intentaría borrar a TODOS, es muy probable un error de fecha/reloj -> no borrar
        if (old.length === members.length) {
            showToast('error', 'Limpieza automática cancelada (revisar fecha del equipo)');
            return;
        }

        old.forEach(m => db.delete(`members/${m.id}`));
        this.logAction('Limpieza Automática', `Se eliminaron automáticamente ${old.length} socios con +3 meses de inactividad.`);
        showToast('success', `${old.length} socios inactivos (+3 meses) eliminados automáticamente`);
    },

    // ===== FIADOS / CUENTAS POR COBRAR =====
    addDebt: function(member, concept, amount, type) {
        if (!member || !member.id) { showToast('error', 'Socio inválido para fiado'); return; }
        db.add('debts', {
            memberId: member.id, memberName: member.name, memberCode: member.code || '',
            concept: concept, amount: Number(amount) || 0, type: type || 'otro',
            date: new Date().toISOString(), status: 'pendiente', createdBy: currentUser.username
        });
        this.logAction('Fiado', `${member.name} fió: ${concept} ($${amount}).`);
    },

    memberSaldo: function(memberId) {
        return debts.filter(d => String(d.memberId) === String(memberId) && d.status === 'pendiente')
                    .reduce((s, d) => s + (Number(d.amount) || 0), 0);
    },

    payDebt: async function(id, metodoPago) {
        const d = debts.find(x => x.id === id);
        if (!d || d.status !== 'pendiente') return;
        const confirmed = await customConfirm('Cobrar fiado', `¿Cobrar "${d.concept}" de ${d.memberName} por $${Number(d.amount).toLocaleString()} (${metodoPago})?`);
        if (!confirmed) return;
        db.update('debts/' + id, { status: 'pagada', paidDate: new Date().toISOString(), paidBy: currentUser.username, metodoPago: metodoPago });
        this.addFinanceLog('PAGO FIADO', d.amount, `${d.concept} - ${d.memberName}`, metodoPago);
        this.logAction('Pago Fiado', `${d.memberName} pagó fiado: ${d.concept} ($${d.amount}). Pago: ${metodoPago}.`);
        showToast('success', 'Fiado cobrado');
    },

    renderDebts: function() {
        const tbody = document.getElementById('debts-table-body');
        const totalEl = document.getElementById('debts-total');
        const countEl = document.getElementById('debts-count');
        if (!tbody) return;
        const pending = debts.filter(d => d.status === 'pendiente').sort((a, b) => new Date(a.date) - new Date(b.date));
        const total = pending.reduce((s, d) => s + (Number(d.amount) || 0), 0);
        if (totalEl) totalEl.innerText = '$' + total.toLocaleString();
        if (countEl) countEl.innerText = pending.length;
        if (pending.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:#666;">No hay fiados pendientes</td></tr>';
            return;
        }
        tbody.innerHTML = pending.map(d => `
            <tr>
                <td style="color:#888; font-size:0.85rem;">${new Date(d.date).toLocaleDateString()}</td>
                <td style="font-weight:600; color:#fff; cursor:pointer;" onclick="app.openMemberDetail('${d.memberId}')">${d.memberName} <small style="color:var(--primary);">${d.memberCode || ''}</small></td>
                <td>${d.concept}</td>
                <td style="color:var(--neon-orange); font-weight:bold; font-family:'Rajdhani';">$${Number(d.amount).toLocaleString()}</td>
                <td style="color:#888;">${d.createdBy || ''}</td>
                <td style="text-align:right; white-space:nowrap;">
                    <button class="btn btn-outline" style="padding:5px 10px; border-color:var(--neon-green); color:var(--neon-green);" onclick="app.payDebt('${d.id}','Efectivo')"><i class="fas fa-money-bill-wave"></i> Efvo</button>
                    <button class="btn btn-outline" style="padding:5px 10px; border-color:#4488ff; color:#4488ff;" onclick="app.payDebt('${d.id}','Tarjeta')"><i class="fas fa-credit-card"></i> Tarj</button>
                </td>
            </tr>`).join('');
    },

    renderMemberDebts: function(memberId) {
        const el = document.getElementById('member-debts-content');
        if (!el) return;
        const pending = debts.filter(d => String(d.memberId) === String(memberId) && d.status === 'pendiente');
        if (pending.length === 0) { el.innerHTML = ''; return; }
        const total = pending.reduce((s, d) => s + (Number(d.amount) || 0), 0);
        el.innerHTML = `
            <div style="margin-top:20px; background:rgba(255,170,0,0.06); border:1px solid rgba(255,170,0,0.3); border-radius:8px; padding:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h4 style="margin:0; color:var(--neon-orange); text-transform:uppercase; font-size:0.9rem;"><i class="fas fa-receipt"></i> Saldo Pendiente (Fiado)</h4>
                    <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.3rem; color:var(--neon-orange);">$${total.toLocaleString()}</span>
                </div>
                ${pending.map(d => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #222; font-size:0.85rem;">
                        <span style="color:#ccc;">${d.concept} <small style="color:#666;">${new Date(d.date).toLocaleDateString()}</small></span>
                        <span style="display:flex; align-items:center; gap:8px;">
                            <b style="color:#fff;">$${Number(d.amount).toLocaleString()}</b>
                            <button class="btn btn-outline" style="padding:3px 9px; font-size:0.7rem; border-color:var(--neon-green); color:var(--neon-green);" onclick="app.payDebt('${d.id}','Efectivo')">Efvo</button>
                            <button class="btn btn-outline" style="padding:3px 9px; font-size:0.7rem; border-color:#4488ff; color:#4488ff;" onclick="app.payDebt('${d.id}','Tarjeta')">Tarj</button>
                        </span>
                    </div>`).join('')}
            </div>`;
    },

    checkoutFiado: async function(total, grouped) {
        const code = await customPrompt('Fiar venta', 'Código del socio que se lleva los productos a cuenta:');
        if (!code) return;
        const member = members.find(m => String(m.code) === String(code).trim());
        if (!member) return showToast('error', 'No se encontró un socio con ese código');
        const confirmed = await customConfirm('Confirmar fiado', `¿Fiar $${total.toLocaleString()} en productos a ${member.name}?`);
        if (!confirmed) return;
        const concept = 'Tienda: ' + [...new Set(cart.map(i => i.name))].join(', ').slice(0, 60);
        Object.keys(grouped).forEach(id => { const p = products.find(x => x.id === id); if (p) db.update(`products/${id}`, { stock: p.stock - grouped[id] }); });
        this.addDebt(member, concept, total, 'tienda');
        this.printReceipt(member.name + ' (FIADO)', total, 'Productos a cuenta');
        this.clearCart();
        showToast('success', `Fiado registrado a ${member.name}`);
    },

    // === RANKING DE ANTIGÜEDAD / LEALTAD ===
    openLoyaltyRanking: function() {
        const modal = document.getElementById('modal-loyalty');
        if (!modal) return;
        modal.style.display = 'flex';
        this.renderLoyalty();
    },

    renderLoyalty: function() {
        const minInput = document.getElementById('loyalty-min-months');
        const minMonths = minInput ? (Number(minInput.value) || 0) : 0;
        const tbody = document.getElementById('loyalty-table-body');
        const summary = document.getElementById('loyalty-summary');
        if (!tbody) return;

        // Más antiguo primero (registeredAt ascendente)
        const ranked = members
            .filter(m => m.registeredAt && tenureMonths(m.registeredAt) >= minMonths)
            .sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt));

        if (summary) {
            const oldest = ranked[0];
            summary.innerHTML = oldest
                ? `Socio más antiguo: <b style="color:var(--neon-orange);">${oldest.name}</b> (${tenureText(oldest.registeredAt)}) · ${ranked.length} socio(s)`
                : 'Sin socios en este filtro';
        }

        if (ranked.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#666;">Sin resultados</td></tr>';
            return;
        }

        tbody.innerHTML = ranked.map((m, i) => {
            const stk = computeStreak(memberAttendanceKeys(m.code));
            const rankColor = i === 0 ? '#ffd700' : (i === 1 ? '#c0c0c0' : (i === 2 ? '#cd7f32' : '#666'));
            return `
                <tr style="cursor:pointer;" onclick="app.closeModal('modal-loyalty'); app.openMemberDetail('${m.id}')">
                    <td style="font-weight:800; color:${rankColor}; font-family:'Rajdhani'; font-size:1.1rem;">#${i + 1}</td>
                    <td style="font-weight:600; color:#fff;">${m.name}</td>
                    <td style="color:var(--primary); font-weight:bold;">${m.code}</td>
                    <td style="color:var(--neon-orange);">${tenureText(m.registeredAt)}</td>
                    <td><i class="fas fa-fire" style="color:#ff6a00;"></i> ${stk.current}</td>
                    <td><i class="fas fa-trophy" style="color:#ffd700;"></i> ${stk.best}</td>
                </tr>`;
        }).join('');
    },

    // Top 5 socios más antiguos para el Dashboard
    // Solo socios vigentes (activos y por vencer). Se excluyen los vencidos/inactivos.
    renderDashLoyalty: function() {
        const ul = document.getElementById('dash-loyalty-list');
        if (!ul) return;
        const now = new Date();
        const ranked = members
            .filter(m => {
                if (!m.registeredAt) return false;
                const days = Math.ceil((new Date(m.expiryDate) - now) / (1000 * 60 * 60 * 24));
                return days >= 0; // activos + por vencer; fuera los vencidos
            })
            .sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt))
            .slice(0, 5);
        if (ranked.length === 0) {
            ul.innerHTML = '<li style="color:#555; padding:6px 0;">Sin socios vigentes</li>';
            return;
        }
        const medal = ['#ffd700', '#c0c0c0', '#cd7f32'];
        ul.innerHTML = ranked.map((m, i) => `
            <li style="display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid #1a1a1a; cursor:pointer;" onclick="app.openMemberDetail('${m.id}')" title="Ver ficha">
                <span style="font-family:'Rajdhani',sans-serif; font-weight:800; font-size:1.1rem; color:${medal[i] || '#666'}; width:26px; flex-shrink:0;">#${i + 1}</span>
                <span style="flex:1; color:#fff; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${m.name}</span>
                <span style="color:var(--neon-orange); font-size:0.8rem; white-space:nowrap; flex-shrink:0;">${tenureText(m.registeredAt)}</span>
            </li>`).join('');
    },

    // Mini ranking de constancia del mes para el Dashboard (top 5)
    renderDashConstancia: function() {
        const ul = document.getElementById('dash-constancia-list');
        if (!ul) return;
        const top = buildAchievementsIndex()
            .filter(a => a.current >= 1)
            .sort((x, y) => y.current - x.current || y.best - x.best || y.totalDays - x.totalDays)
            .slice(0, 5);
        if (top.length === 0) {
            ul.innerHTML = '<li style="color:#555; padding:6px 0;">Sin rachas activas</li>';
            return;
        }
        const medal = ['#ffd700', '#c0c0c0', '#cd7f32'];
        ul.innerHTML = top.map((a, i) => `
            <li style="display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid #1a1a1a;">
                <span style="font-family:'Rajdhani',sans-serif; font-weight:800; font-size:1.1rem; color:${medal[i] || '#666'}; width:26px; flex-shrink:0;">#${i + 1}</span>
                <span style="flex:1; color:#fff; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${i === 0 ? '<i class="fas fa-crown" style="color:#ffd700; margin-right:5px; filter:drop-shadow(0 0 5px rgba(255,215,0,0.6));"></i>' : ''}${a.m.name}</span>
                <span style="color:#ff6a00; font-weight:700; font-size:0.85rem; flex-shrink:0;" title="Racha actual"><i class="fas fa-fire"></i> ${a.current}</span>
                <span style="color:#9aa; font-size:0.8rem; flex-shrink:0;" title="Mejor racha (récord)">réc ${a.best}</span>
            </li>`).join('');
    },

    // Sección completa de Logros: insignias + ranking de constancia del mes
    renderLogros: function() {
        const list = buildAchievementsIndex();

        // Insignias (catálogo): se "encienden" si al menos un socio las tiene
        const badgesEl = document.getElementById('logros-badges');
        if (badgesEl) {
            badgesEl.innerHTML = BADGES.map(b => {
                const count = list.filter(a => b.test(a)).length;
                const on = count > 0;
                return `
                    <div class="ach-badge ${on ? 'on' : 'off'}" onclick="app.showBadgeMembers('${b.key}')" title="Ver quién tiene esta insignia">
                        ${on ? '<i class="ti ti-check ach-rib"></i>' : '<i class="ti ti-lock ach-lock"></i>'}
                        <div class="ach-ic" style="${on ? `color:${b.color}; box-shadow:0 0 18px ${b.color}66;` : ''}"><i class="ti ${b.icon}"></i></div>
                        <div class="ach-nm">${b.name}</div>
                        <div class="ach-rq">${b.req}</div>
                        <div class="ach-ct">${on ? count + ' socio' + (count === 1 ? '' : 's') : 'Nadie aún'}</div>
                    </div>`;
            }).join('');
        }

        // Ranking por RACHA ACTIVA (permanente). Si pierdes la racha, bajas; otro sube.
        const titleEl = document.getElementById('logros-ranking-title');
        if (titleEl) titleEl.innerHTML = `<i class="ti ti-trophy" style="color:#ffd700;"></i> Ranking de Rachas`;

        const fullRanking = list
            .filter(a => a.current >= 1)
            .sort((x, y) => y.current - x.current || y.best - x.best || y.totalDays - x.totalDays);

        // Posiciones actuales y flechas vs la foto anterior (subió/bajó)
        const curPositions = {};
        fullRanking.forEach((a, i) => { curPositions[a.m.code] = i + 1; });
        const prevPos = (rankingSnapshot && rankingSnapshot.positions) || {};
        const arrowFor = (code, pos) => {
            const p = prevPos[code];
            if (p === undefined || p === null) return '<span class="rk-arrow rk-new" title="Nuevo en el ranking">&bull;</span>';
            if (pos < p) return `<span class="rk-arrow rk-up" title="Subió ${p - pos} lugar(es)"><i class="fas fa-caret-up"></i></span>`;
            if (pos > p) return `<span class="rk-arrow rk-down" title="Bajó ${pos - p} lugar(es)"><i class="fas fa-caret-down"></i></span>`;
            return '<span class="rk-arrow rk-same" title="Sin cambio"><i class="fas fa-minus"></i></span>';
        };

        const ranking = fullRanking.slice(0, 10);
        const rkEl = document.getElementById('logros-ranking');
        if (rkEl) {
            rkEl.innerHTML = ranking.length === 0
                ? '<div style="color:#666; padding:24px; text-align:center; background:#101010; border:1px solid #1c1c1c; border-radius:12px;">Nadie tiene una racha activa ahora mismo</div>'
                : ranking.map((a, i) => {
                    const col = i === 0 ? '#ffd700' : (i === 1 ? '#c0c0c0' : (i === 2 ? '#cd7f32' : '#666'));
                    const rankClass = i < 3 ? ' ach-rk-' + (i + 1) : '';
                    const crown = i === 0 ? '<i class="ti ti-crown ach-crown"></i>' : '';
                    const leader = i === 0 ? '<span class="ach-leader">LÍDER</span>' : '';
                    return `
                        <div class="ach-rk${rankClass}" onclick="app.openMemberDetail('${a.m.id}')" title="Ver ficha">
                            <span class="ach-pos" style="color:${col};">${i + 1}</span>
                            ${arrowFor(a.m.code, i + 1)}
                            <span class="ach-name">${crown}${a.m.name}${leader}</span>
                            <span class="ach-flame" title="Racha actual"><i class="ti ti-flame"></i> ${a.current}</span>
                            <span class="ach-days" title="Mejor racha (récord)">récord ${a.best}</span>
                        </div>`;
                }).join('');
        }

        // Actualizar la foto del ranking 1 vez al día (base de las flechas de mañana)
        const _todayKey = localDateKey(new Date());
        if (fullRanking.length && (!rankingSnapshot || rankingSnapshot.date !== _todayKey)) {
            rankingSnapshot = { date: _todayKey, positions: curPositions }; // evita doble escritura en el mismo tick
            db.set('config/rankingSnapshot', rankingSnapshot);
        }
    },

    // Muestra QUIÉNES tienen una insignia (al hacer clic en ella)
    showBadgeMembers: function(key) {
        const b = BADGES.find(x => x.key === key);
        if (!b) return;
        // Métrica relevante según la insignia (para ordenar y mostrar)
        const metric = a => (b.key === 'early' ? a.early : (b.key === 'weekend' ? a.weekendDays : a.best));
        const statText = a => {
            if (b.key === 'early') return `${a.early} entradas tempranas`;
            if (b.key === 'weekend') return `${a.weekendDays} días de finde`;
            return `Mejor racha: ${a.best} días`;
        };
        const winners = buildAchievementsIndex().filter(a => b.test(a)).sort((x, y) => metric(y) - metric(x));

        document.getElementById('badge-modal-title').innerHTML = `<i class="ti ${b.icon}" style="color:${b.color};"></i> ${b.name}`;
        document.getElementById('badge-modal-sub').innerHTML = `${b.req} · ${winners.length} socio${winners.length === 1 ? '' : 's'}`;
        const box = document.getElementById('badge-members-list');
        if (winners.length === 0) {
            box.innerHTML = '<div style="color:#666; padding:30px; text-align:center;">Nadie ha desbloqueado esta insignia todavía</div>';
        } else {
            box.innerHTML = winners.map((a, i) => `
                <div class="badge-member-row" onclick="app.closeModal('modal-badge-members'); app.openMemberDetail('${a.m.id}')" title="Ver ficha">
                    <span class="bm-pos">${i + 1}</span>
                    <span class="bm-name">${a.m.name}</span>
                    <span class="bm-code">${a.m.code}</span>
                    <span class="bm-stat" style="color:${b.color};">${statText(a)}</span>
                </div>`).join('');
        }
        document.getElementById('modal-badge-members').style.display = 'flex';
    },

    loadEmployees: function() {
        const tbody = document.getElementById('employee-table-body'); if(!tbody) return;
        tbody.innerHTML = '';
        users.forEach(u => { tbody.innerHTML += `<tr><td style="color:#fff;">${u.name}</td><td style="color:#888;">${u.username} (${u.role})</td><td style="text-align:right;"><button onclick="app.delEmp('${u.id}')" style="color:var(--primary); background:none; border:none; cursor:pointer;"><i class="fas fa-trash"></i></button></td></tr>`; });
    },

    registerEmployee: function() {
        const name = document.getElementById('emp-name').value, user = document.getElementById('emp-user').value, pass = document.getElementById('emp-pass').value, role = document.getElementById('emp-role').value;
        if(!name || !user || !pass) return showToast('error', 'Faltan datos');
        db.add("users", { name, username: user, password: pass, role });
        this.logAction('Registro Empleado', `Se registró al empleado ${name} (${user}).`);
        showToast('success', 'Registrado');
    },

    delEmp: async function(id) {
        const confirmed = await customConfirm("Eliminar Empleado", "¿Estás seguro de que quieres eliminar este empleado?");
        if(confirmed) {
            const userToDelete = users.find(u => u.id === id);
            db.delete(`users/${id}`);
            this.logAction('Eliminación Empleado', `Se eliminó al empleado ${userToDelete.name} (${userToDelete.username}).`);
            showToast('success', 'Eliminado');
        }
    },

    renderHistory: function() {
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;

        const sortedHistory = [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
        let html = '';

        if (sortedHistory.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:50px; color:#666;">No hay acciones registradas.</td></tr>';
            return;
        }

        sortedHistory.forEach(h => {
            const dateObj = new Date(h.date);
            html += `
                <tr>
                    <td style="font-size:0.85rem; color:#888;">${dateObj.toLocaleString()}</td>
                    <td style="font-weight:600; color:#fff;">${h.type}</td>
                    <td>${h.description}</td>
                    <td style="color:#aaa;">${h.user}</td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    },

    clearHistory: async function() {
        if (currentUser.role !== 'admin' && currentUser.role !== 'dev') return showToast('error', 'Acceso denegado');
        const confirmed = await customConfirm("Limpiar Historial", "¡ATENCIÓN! Esta acción eliminará permanentemente todo el historial de acciones. ¿Estás seguro?");
        if (confirmed) {
            const password = await customPrompt("Confirmar Acción", "Ingrese la contraseña de ADMINISTRADOR para continuar:", '', 'password');
            if (password === 'AtlassCC') {
                db.delete('history');
                this.logAction('Limpieza Historial', 'Se ha limpiado todo el historial de acciones.');
                showToast('success', 'Historial eliminado exitosamente.');
            } else if (password !== null) {
                showToast('error', 'Contraseña incorrecta. Acción cancelada.');
            }
        }
    },

    closeModal: function(id) { document.getElementById(id).style.display = 'none'; },

    dev: {
        broadcast: function() {
            const msg = document.getElementById('dev-broadcast-msg').value.trim();
            // If empty, clear the broadcast
            const payload = {
                message: msg,
                sender: currentUser.username,
                timestamp: Date.now()
            };
            
            db.set('config/broadcast', payload);
            
            if (msg) {
                app.logAction('Global Broadcast', `Se envió el comunicado: "${msg}"`);
                showToast('success', 'Comunicado enviado a todas las pantallas.');
                document.getElementById('dev-broadcast-msg').value = '';
            } else {
                showToast('success', 'Comunicado eliminado/oculto.');
            }
        },
        loadUsers: function() {
            const forceLogoutSelect = document.getElementById('dev-user-list');
            const hideSectionsSelect = document.getElementById('dev-hide-user-list');

            if (forceLogoutSelect) {
                forceLogoutSelect.innerHTML = '<option value="">Select a user...</option>';
                users.forEach(u => {
                    if (u.username !== currentUser.username) {
                        const option = document.createElement('option');
                        option.value = u.id;
                        option.textContent = `${u.name} (${u.username})`;
                        forceLogoutSelect.appendChild(option);
                    }
                });
            }

            if (hideSectionsSelect) {
                hideSectionsSelect.innerHTML = '<option value="">Select a user...</option>';
                users.forEach(u => {
                    // MVD user cannot be edited
                    if (u.username !== 'MVD') {
                        const option = document.createElement('option');
                        option.value = u.id;
                        option.textContent = `${u.name} (${u.username})`;
                        hideSectionsSelect.appendChild(option);
                    }
                });
            }
        },
        loadUserSections: function() {
            const userId = document.getElementById('dev-hide-user-list').value;
            const checklist = document.getElementById('dev-sections-checklist');
            if (!checklist) return;
            checklist.innerHTML = ''; // Clear previous checkboxes

            if (!userId) return; // Do nothing if no user is selected

            const user = users.find(u => u.id === userId);
            const hiddenSections = user.hiddenSections || [];
            
            const allSections = ['dashboard', 'members', 'store', 'finances', 'trash', 'admin', 'reports', 'history'];
            
            allSections.forEach(section => {
                const isChecked = hiddenSections.includes(section);
                const label = document.createElement('label');
                label.className = 'checkbox-label';
                label.innerHTML = `
                    <input type="checkbox" value="${section}" ${isChecked ? 'checked' : ''}>
                    ${section.charAt(0).toUpperCase() + section.slice(1)}
                `;
                checklist.appendChild(label);
            });
        },
        saveHiddenSections: async function() {
            const userId = document.getElementById('dev-hide-user-list').value;
            if (!userId) {
                showToast('error', 'Please select a user.');
                return;
            }

            const checklist = document.getElementById('dev-sections-checklist');
            const checkboxes = checklist.querySelectorAll('input[type="checkbox"]');
            const hiddenSections = [];
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    hiddenSections.push(cb.value);
                }
            });

            const user = users.find(u => u.id === userId);
            await db.update(`users/${userId}`, { hiddenSections: hiddenSections });
            
            app.logAction('Updated Section Visibility', `Updated section visibility for user ${user.name}.`);
            showToast('success', `Visibility settings for ${user.name} have been updated.`);
        },
        forceLogout: async function() {
            const select = document.getElementById('dev-user-list');
            const userId = select.value;
            if (!userId) {
                showToast('error', 'Please select a user to logout.');
                return;
            }
            const userToLogout = users.find(u => u.id === userId);
            const confirmed = await customConfirm("Force Logout", `Are you sure you want to force logout ${userToLogout.name}? They will be immediately signed out.`);
            if (confirmed) {
                await db.update(`users/${userId}`, { forceLogout: true });
                app.logAction('Forced Logout', `Forced logout for user ${userToLogout.name} (${userToLogout.username}).`);
                showToast('success', `${userToLogout.name} has been logged out.`);
                select.value = ''; // Reset dropdown
            }
        },
        fullReset: async function() {
            const confirmed = await customConfirm("Full Application Reset", "ARE YOU SURE? This will delete all data and cannot be undone.");
            if (confirmed) {
                db.delete('/'); 
                location.reload();
            }
        },
        updateColor: function(variable, value) {
            // Update locally for immediate feedback
            document.documentElement.style.setProperty(variable, value);
            // Save to Firebase to sync with all users
            db.set('config/theme', { primaryColor: value });
            app.logAction('Theme Update', `Primary color changed to ${value}.`);
        }
    },

    reports: {
        currentReportData: null,
        
        init: function() {
            // Este método puede usarse en el futuro si se necesita inicialización.
            console.log("Centro de Reportes Inicializado.");
        },

        show: function(type) {
            const container = document.getElementById('report-generator-content');
            container.innerHTML = '<h2>Cargando...</h2>';
            document.getElementById('report-generator-modal').style.display = 'flex';

            let content = '';
            switch(type) {
                case 'members':
                    content = this.getMembersForm();
                    break;
                case 'finances':
                    content = this.getFinancesForm();
                    break;
                case 'store':
                    content = this.getStoreForm();
                    break;
                case 'activity':
                    content = this.getActivityForm();
                    break;
            }
            container.innerHTML = content;
        },
        
        getMembersForm: function() {
            return `
                <h2><i class="fas fa-users"></i> Reporte de Socios</h2>
                <p>Seleccione el tipo de reporte de socios que desea generar.</p>
                <div class="form-group">
                    <label>Tipo de Reporte</label>
                    <select id="report-member-type" class="form-control">
                        <option value="all">Lista Completa de Socios</option>
                        <option value="active">Socios Activos</option>
                        <option value="inactive">Socios Inactivos</option>
                        <option value="expiring">Socios Por Vencer (Próximos 5 días)</option>
                    </select>
                </div>
                <button class="btn" onclick="app.reports.generate('members')">Generar Reporte</button>
                <div id="report-preview" class="report-preview-container"></div>
            `;
        },

        getFinancesForm: function() {
            return `
                <h2><i class="fas fa-cash-register"></i> Reporte Financiero</h2>
                <p>Seleccione un rango de fechas para generar el reporte.</p>
                <div class="form-grid">
                    <div class="form-group">
                        <label>Desde</label>
                        <input type="date" id="report-finance-start" class="form-control">
                    </div>
                    <div class="form-group">
                        <label>Hasta</label>
                        <input type="date" id="report-finance-end" class="form-control">
                    </div>
                </div>
                <button class="btn" onclick="app.reports.generate('finances')">Generar Reporte</button>
                <div id="report-preview" class="report-preview-container"></div>
            `;
        },
        
        getStoreForm: function() {
            return `
                <h2><i class="fas fa-store"></i> Reporte de Tienda</h2>
                <p>Seleccione el tipo de reporte de tienda que desea generar.</p>
                <div class="form-group">
                    <label>Tipo de Reporte</label>
                    <select id="report-store-type" class="form-control">
                        <option value="inventory">Inventario Actual</option>
                        <option value="lowstock">Productos con Bajo Stock (<= 3)</option>
                    </select>
                </div>
                <button class="btn" onclick="app.reports.generate('store')">Generar Reporte</button>
                <div id="report-preview" class="report-preview-container"></div>
            `;
        },

        getActivityForm: function() {
            return `
                <h2><i class="fas fa-history"></i> Reporte de Actividad</h2>
                <p>Seleccione un rango de fechas para el reporte de actividad.</p>
                <div class="form-grid">
                    <div class="form-group">
                        <label>Desde</label>
                        <input type="date" id="report-activity-start" class="form-control">
                    </div>
                    <div class="form-group">
                        <label>Hasta</label>
                        <input type="date" id="report-activity-end" class="form-control">
                    </div>
                </div>
                <button class="btn" onclick="app.reports.generate('activity')">Generar Reporte de Visitas</button>
                <div id="report-preview" class="report-preview-container"></div>
            `;
        },

        generate: function(type) {
            const preview = document.getElementById('report-preview');
            this.currentReportData = null; 
            let data, title, content;

            switch(type) {
                case 'members':
                    const memberType = document.getElementById('report-member-type').value;
                    data = this.generateMemberData(memberType);
                    title = `Reporte de Socios: ${memberType.toUpperCase()}`;
                    content = this.renderTable(data.headers, data.rows);
                    break;
                case 'finances':
                    const start = document.getElementById('report-finance-start').value;
                    const end = document.getElementById('report-finance-end').value;
                    if (!start || !end) { showToast('error', 'Seleccione ambas fechas.'); return; }
                    data = this.generateFinanceData(start, end);
                    title = `Reporte Financiero de ${start} a ${end}`;
                    content = this.renderFinanceTable(data);
                    break;
                    case 'store':
                    const storeType = document.getElementById('report-store-type').value;
                    data = this.generateStoreData(storeType);
                    title = `Reporte de Tienda: ${storeType === 'inventory' ? 'Inventario' : 'Bajo Stock'}`;
                    content = this.renderTable(data.headers, data.rows);
                    break;
                case 'activity':
                    const actStart = document.getElementById('report-activity-start').value;
                    const actEnd = document.getElementById('report-activity-end').value;
                    if (!actStart || !actEnd) { showToast('error', 'Seleccione ambas fechas.'); return; }
                    data = this.generateActivityData(actStart, actEnd);
                    title = `Historial de Visitas de ${actStart} a ${actEnd}`;
                    content = this.renderTable(data.headers, data.rows);
                    break;
            }

            this.currentReportData = { title, content, type, summary: data ? data.summary || {} : {}, rowCount: data ? data.rows.length : 0 };
            preview.innerHTML = `<h3 style="margin-top:20px; font-family:'Rajdhani'">${title}</h3>${content}`;
        },
        
        generateMemberData: function(memberType) {
            const headers = ["Código", "Nombre", "Teléfono", "Plan", "Registro", "Vencimiento", "Estado"];
            const today = new Date();
            let filteredMembers = [];

            switch(memberType) {
                case 'all': filteredMembers = members; break;
                case 'active':
                    filteredMembers = members.filter(m => (new Date(m.expiryDate) - today) / (1000 * 60 * 60 * 24) > 5);
                    break;
                case 'inactive':
                    filteredMembers = members.filter(m => (new Date(m.expiryDate) - today) < 0);
                    break;
                case 'expiring':
                    filteredMembers = members.filter(m => {
                        const days = (new Date(m.expiryDate) - today) / (1000 * 60 * 60 * 24);
                        return days >= 0 && days <= 5;
                    });
                    break;
            }

            const rows = filteredMembers.map(m => {
                const days = Math.ceil((new Date(m.expiryDate) - today) / (1000*60*60*24));
                let status = days < 0 ? 'Vencido' : (days <= 5 ? 'Por Vencer' : 'Activo');
                return [m.code, m.name, m.phone || 'N/A', PLAN_NAMES[m.plan] || m.plan || 'N/A', new Date(m.registeredAt).toLocaleDateString(), new Date(m.expiryDate).toLocaleDateString(), status];
            });

            const activeCount = filteredMembers.filter(m => Math.ceil((new Date(m.expiryDate) - today)/(1000*60*60*24)) > 5).length;
            const expiringCount = filteredMembers.filter(m => { const d = Math.ceil((new Date(m.expiryDate) - today)/(1000*60*60*24)); return d >= 0 && d <= 5; }).length;
            const inactiveCount = filteredMembers.filter(m => (new Date(m.expiryDate) - today) < 0).length;

            return { headers, rows, summary: { total: filteredMembers.length, active: activeCount, expiring: expiringCount, inactive: inactiveCount, type: memberType } };
        },

        generateFinanceData: function(start, end) {
            const startDate = new Date(start);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(end);
            endDate.setHours(23, 59, 59, 999);

            const filteredFinances = finances.filter(f => {
                const fDate = new Date(f.date);
                return fDate >= startDate && fDate <= endDate;
            });
            
            let totalIncome = 0;
            let totalExpense = 0;
            const rows = [];

            filteredFinances.forEach(f => {
                const isExpense = String(f.type).toLowerCase() === 'gasto';
                if(isExpense) totalExpense += f.amount;
                else totalIncome += f.amount;
                rows.push([
                    new Date(f.date).toLocaleString(),
                    f.type,
                    f.desc,
                    f.user,
                    (isExpense ? '-' : '+') + `$${f.amount.toLocaleString()}`
                ]);
            });

            return {
                headers: ["Fecha/Hora", "Tipo", "Concepto", "Usuario", "Monto"],
                rows: rows.sort((a,b) => new Date(b[0]) - new Date(a[0])), // Ordenar por fecha descendente
                summary: {
                    income: totalIncome,
                    expense: totalExpense,
                    balance: totalIncome - totalExpense
                }
            };
        },

        generateStoreData: function(storeType) {
            const headers = ["Producto", "Categoría", "Precio", "Stock Actual", "Valor en Inventario"];
            let filteredProducts = products;
            if (storeType === 'lowstock') {
                filteredProducts = products.filter(p => p.stock <= 3);
            }
            let totalValue = 0, lowStockCount = 0, outOfStockCount = 0;
            const rows = filteredProducts.map(p => {
                const val = p.price * p.stock;
                totalValue += val;
                if (p.stock <= 3) lowStockCount++;
                if (p.stock === 0) outOfStockCount++;
                return [p.name, p.category, '$' + p.price.toLocaleString(), p.stock, '$' + val.toLocaleString()];
            });
            return { headers, rows, summary: { totalProducts: filteredProducts.length, totalValue, lowStockCount, outOfStockCount } };
        },
        
        generateActivityData: function(start, end) {
            const headers = ["Socio", "Código", "Fecha / Hora", "Estado"];
            const startDate = new Date(start);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(end);
            endDate.setHours(23, 59, 59, 999);
            
            const filteredVisits = visits.filter(v => {
                const vDate = new Date(v.date);
                return vDate >= startDate && vDate <= endDate;
            });

            const uniqueMembers = new Set(filteredVisits.map(v => v.code));
            const rows = filteredVisits.map(v => [v.name, v.code, new Date(v.date).toLocaleString(), v.status === 'success' ? 'Exitosa' : 'Denegada']);
            return { headers, rows: rows.sort((a,b) => new Date(b[2]) - new Date(a[2])), summary: { totalVisits: filteredVisits.length, uniqueMembers: uniqueMembers.size, startDate: start, endDate: end } };
        },

        renderTable: function(headers, rows) {
            if (rows.length === 0) return '<p style="text-align:center; color:#666; padding:20px;">No hay datos para mostrar.</p>';
            let table = '<table class="report-table-compact"><thead><tr>';
            headers.forEach(h => table += `<th>${h}</th>`);
            table += '</tr></thead><tbody>';
            rows.forEach(row => {
                table += '<tr>';
                row.forEach(cell => table += `<td>${cell}</td>`);
                table += '</tr>';
            });
            table += '</tbody></table>';
            return table;
        },

        renderFinanceTable: function(data) {
            let content = this.renderTable(data.headers, data.rows);
            content += `
                <div class="report-summary-bar" style="margin-top:20px;">
                    <div class="sum-item"><strong>INGRESOS:</strong> $${data.summary.income.toLocaleString()}</div>
                    <div class="sum-item"><strong>GASTOS:</strong> $${data.summary.expense.toLocaleString()}</div>
                    <div class="sum-item"><strong>BALANCE NETO:</strong> $${data.summary.balance.toLocaleString()}</div>
                </div>
            `;
            return content;
        },

        printCurrent: function() {
            if (!this.currentReportData) {
                showToast('error', 'Primero genere un reporte.');
                return;
            }

            const rd = this.currentReportData;
            const sm = rd.summary || {};
            let kpisHTML = '';

            // Build KPI cards based on report type
            if (rd.type === 'members') {
                kpisHTML = '<div class="atlas-report-kpis">'
                    + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Total Socios</span><span class="atlas-kpi-value">' + (sm.total || rd.rowCount || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Activos</span><span class="atlas-kpi-value" style="color:#2e7d32">' + (sm.active || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Por Vencer</span><span class="atlas-kpi-value" style="color:#e65100">' + (sm.expiring || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Vencidos</span><span class="atlas-kpi-value" style="color:#c62828">' + (sm.inactive || 0) + '</span></div>'
                    + '</div>';
            } else if (rd.type === 'finances') {
                kpisHTML = '<div class="atlas-report-kpis">'
                    + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Ingresos</span><span class="atlas-kpi-value" style="color:#2e7d32">$' + (sm.income || 0).toLocaleString() + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Gastos</span><span class="atlas-kpi-value" style="color:#c62828">$' + (sm.expense || 0).toLocaleString() + '</span></div>'
                    + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Balance</span><span class="atlas-kpi-value">$' + (sm.balance || 0).toLocaleString() + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Registros</span><span class="atlas-kpi-value">' + (rd.rowCount || 0) + '</span></div>'
                    + '</div>';
            } else if (rd.type === 'store') {
                kpisHTML = '<div class="atlas-report-kpis">'
                    + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Total Productos</span><span class="atlas-kpi-value">' + (sm.totalProducts || rd.rowCount || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Valor Inventario</span><span class="atlas-kpi-value" style="color:#2e7d32">$' + (sm.totalValue || 0).toLocaleString() + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Bajo Stock</span><span class="atlas-kpi-value" style="color:#e65100">' + (sm.lowStockCount || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Agotados</span><span class="atlas-kpi-value" style="color:#c62828">' + (sm.outOfStockCount || 0) + '</span></div>'
                    + '</div>';
            } else if (rd.type === 'activity') {
                kpisHTML = '<div class="atlas-report-kpis">'
                    + '<div class="atlas-kpi highlight"><span class="atlas-kpi-label">Total Visitas</span><span class="atlas-kpi-value">' + (sm.totalVisits || rd.rowCount || 0) + '</span></div>'
                    + '<div class="atlas-kpi"><span class="atlas-kpi-label">Socios Unicos</span><span class="atlas-kpi-value">' + (sm.uniqueMembers || 0) + '</span></div>'
                    + '</div>';
            }

            // Convert screen table content to print-friendly table
            let printContent = rd.content;
            printContent = printContent.replace(/report-table-compact/g, 'atlas-report-table');
            printContent = printContent.replace(/report-summary-bar/g, 'atlas-report-summary');
            printContent = printContent.replace(/sum-item/g, 'atlas-summary-item');

            const printHTML = '<div class="atlas-report">'
                + '<header class="atlas-report-header">'
                + '<div class="atlas-report-header-left">'
                + '<img src="Logo/ATLAS.png" alt="Atlas Gym">'
                + '<div><h1>ATLAS GYM - REPORTE</h1>'
                + '<p>' + rd.title + '</p></div></div>'
                + '<div class="atlas-report-meta">'
                + '<p>Generado: ' + new Date().toLocaleString('es-MX') + '</p>'
                + '<p>Usuario: ' + currentUser.name + '</p></div></header>'
                + kpisHTML
                + printContent
                + '<footer class="atlas-report-footer">'
                + '<span class="atlas-report-footer-note">' + (rd.rowCount || 0) + ' registros procesados.</span>'
                + '<span>Atlas Gym - Sistema de Gestion</span>'
                + '</footer></div>';

            document.getElementById('printable-area').innerHTML = printHTML;
            window.print();
        }
    }
};
