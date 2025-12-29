import { database } from './firebase-config.js';
import { ref, set, get, push, remove, update, onValue } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

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
let cart = [];
let selectedMemberId = null;
let prices = { "1": 500, "3": 1200, "12": 4000 };

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
            this.renderMembers();
            this.calcStats();
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

        this.nav('dashboard');
    },

    nav: function(viewId) {
        document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`view-${viewId}`);
        if(target) target.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        if(event && event.currentTarget) event.currentTarget.classList.add('active');

        if(viewId === 'dashboard') this.calcStats();
        if(viewId === 'finances') this.loadFinances('default'); 
        if(viewId === 'admin') this.loadEmployees(); 
        if(viewId === 'trash') this.renderTrash();
        if(viewId === 'history') this.renderHistory();
        if(viewId === 'reports') this.reports.init();
        if(viewId === 'dev') this.dev.loadUsers();
    },

    // 3. DASHBOARD
    calcStats: function() {
        const today = new Date();
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const todayVisits = visits.filter(v => new Date(v.date) >= startOfDay);
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
        document.getElementById('stat-inactive').innerText = inactive;
    },

    // 4. SOCIOS
    renderMembers: function(filter = 'all') {
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
        // Limpia los campos del formulario por si quedaron datos previos
        document.getElementById('reg-name').value = '';
        document.getElementById('reg-phone').value = '';
        document.getElementById('reg-email').value = '';
        document.getElementById('reg-dob').value = '';
        // Muestra el modal
        document.getElementById('modal-register').style.display = 'flex';
    },

    updateRegisterPrice: function() {
        const plan = document.getElementById('reg-plan').value;
        const display = document.getElementById('reg-price-display');
        if (display) {
            display.innerText = `$${prices[plan]}`;
        }
    },

    confirmRegister: function() {
        const name = document.getElementById('reg-name').value;
        const phone = document.getElementById('reg-phone').value;
        const plan = document.getElementById('reg-plan').value;
        if(!name || !phone) return showToast('error', 'Faltan datos');
        const code = Math.floor(10000 + Math.random() * 90000).toString();
        const exp = new Date(); exp.setMonth(exp.getMonth() + parseInt(plan));
        const newMember = { name, phone, dob: document.getElementById('reg-dob').value, email: document.getElementById('reg-email').value, plan, code, expiryDate: exp.toISOString(), registeredAt: new Date().toISOString(), registeredBy: currentUser.username };
        db.add("members", newMember);
        this.addFinanceLog('INSCRIPCION', prices[plan], `Socio: ${name}`);
        this.logAction('Registro Socio', `Se registró al socio ${name} (${code}).`);
        showToast('success', 'Socio registrado');
        this.closeModal('modal-register');
        this.printReceipt(name, prices[plan], `Membresía ${plan} Meses`);

        // Enviar mensaje de WhatsApp
        const welcomeMessage = `¡Hola ${name.split(' ')[0]}! 👋 ¡Bienvenido a ATLAS GYM! Tu código de acceso es: *${code}*. ¡A entrenar con todo! 💪`;
        const encodedMessage = encodeURIComponent(welcomeMessage);
        const whatsappUrl = `https://wa.me/${phone}?text=${encodedMessage}`;
        window.open(whatsappUrl, '_blank');
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
        `;
        
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
        const password = await customPrompt("Confirmar Eliminación", "Ingrese la contraseña de ADMINISTRADOR para eliminar este socio:", '', 'password');
        if(password === 'AtlassCC') {
            const m = members.find(x => String(x.id) === String(selectedMemberId));
            const memberData = { ...m, deletedAt: new Date().toISOString(), deletedBy: currentUser.username };
            
            db.set(`trash/${m.id}`, memberData);
            db.delete(`members/${selectedMemberId}`);

            this.logAction('Eliminación Socio', `Se eliminó al socio ${m.name} (${m.code}).`);
            showToast('success', 'Socio movido a la papelera');
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
        document.getElementById('renew-member-info').innerHTML = `<h4 style="margin:0">${m.name}</h4><small style="color:#aaa">Fecha actual de vencimiento: ${new Date(m.expiryDate).toLocaleDateString()}</small>`;
        this.updateRenewPrice();
        document.getElementById('modal-renew-pro').style.display = 'flex';
    },

    updateRenewPrice: function() {
        const p = document.getElementById('renew-plan-select').value;
        document.getElementById('renew-price-display').innerText = `$${prices[p]}`;
    },

    confirmRenewal: function() {
        const plan = document.getElementById('renew-plan-select').value;
        const m = members.find(x => String(x.id) === String(selectedMemberId));
        let d = new Date(m.expiryDate); if(d < new Date()) d = new Date(); d.setMonth(d.getMonth() + parseInt(plan));
        db.update(`members/${selectedMemberId}`, { expiryDate: d.toISOString() });
        this.addFinanceLog('RENOVACION', prices[plan], `Socio: ${m.name}`);
        this.logAction('Renovación', `Se renovó la membresía de ${m.name} por ${plan} mes(es).`);
        showToast('success', 'Membresía renovada con éxito');
        this.closeModal('modal-renew-pro');
        this.closeModal('modal-member-detail');
        this.printReceipt(m.name, prices[plan], `Renovación ${plan} Mes/es`);
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

    renderTrash: function() {
        const tbody = document.getElementById('trash-table-body');
        tbody.innerHTML = '';

        if (trash.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:50px; color:#666;">La papelera está vacía.</td></tr>`;
            return;
        }

        trash.forEach(m => {
            const deletedDate = m.deletedAt ? new Date(m.deletedAt).toLocaleDateString() : 'N/A';
            tbody.innerHTML += `
                <tr>
                    <td>${m.name}</td>
                    <td>${m.code}</td>
                    <td style="color:#aaa;">${m.deletedBy || 'N/A'}</td>
                    <td style="color:#aaa;">${deletedDate}</td>
                    <td style="text-align:right;">
                        <button class="btn btn-outline" style="border-color:var(--neon-green); color:var(--neon-green);" onclick="app.restoreMember('${m.id}')">
                            <i class="fas fa-undo-alt"></i> Restaurar
                        </button>
                        <button class="btn admin-only" style="background:#d32f2f;" onclick="app.purgeMember('${m.id}')">
                            <i class="fas fa-fire"></i> Purga
                        </button>
                    </td>
                </tr>
            `;
        });
    },

    restoreMember: async function(id) {
        const confirmed = await customConfirm("Restaurar Socio", "¿Seguro que quieres restaurar este socio?");
        if (!confirmed) return;

        const memberToRestore = trash.find(m => m.id === id);

        if (memberToRestore) {
            db.set(`members/${id}`, memberToRestore);
            db.delete(`trash/${id}`);
            
            this.logAction('Restauración Socio', `Se restauró al socio ${memberToRestore.name} (${memberToRestore.code}).`);
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
            grid.innerHTML += `<div class="prod-item ${isLow ? 'stock-alert' : ''} ${isOut ? 'out-of-stock' : ''}" onclick="${isOut ? '' : `app.addToCart('${p.id}')`}" style="position:relative; opacity: ${isOut ? '0.6' : '1'}">${isOut ? '<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-15deg); background:var(--primary); color:white; padding:5px 10px; font-weight:bold; z-index:2; border-radius:4px;">AGOTADO</div>' : ''}<div style="font-size: 2rem; margin-bottom:10px; color: ${isLow ? 'var(--neon-orange)' : 'var(--primary)'}"><i class="fas ${p.icon || 'fa-box'}"></i></div><small style="text-transform:uppercase; color:#888;">${p.category || 'General'}</small><h4 style="margin: 5px 0;">${p.name}</h4><p style="color:var(--neon-green); font-weight:bold; font-size:1.2rem; margin: 10px 0;">$${p.price}</p><div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;"><span style="font-size:0.85rem; color:${isLow ? 'var(--neon-orange)' : '#aaa'}">Stock: <b>${p.stock}</b></span><div class="prod-actions"><button onclick="event.stopPropagation(); app.addStock('${p.id}')" class="btn-mini-stock" title="Reponer"><i class="fas fa-plus"></i></button>${(currentUser.role === 'admin' || currentUser.role === 'dev') ? `<button onclick="event.stopPropagation(); app.delProd('${p.id}')" class="btn-mini-del" title="Eliminar"><i class="fas fa-times"></i></button>` : ''}</div></div></div>`;
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
        const total = cart.reduce((sum, item) => sum + item.price, 0);
        const grouped = cart.reduce((acc, item) => { acc[item.id] = (acc[item.id] || 0) + 1; return acc; }, {});
        Object.keys(grouped).forEach(id => {
            const p = products.find(x => x.id === id);
            db.update(`products/${id}`, { stock: p.stock - grouped[id] });
        });
        this.addFinanceLog('TIENDA', total, `Venta Tienda`);
        this.logAction('Venta Tienda', `Se realizó una venta en la tienda por un total de $${total}.`);
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
            let userMatch = true;
            if (filterUser !== 'all') userMatch = f.user === filterUser;
            return dateMatch && typeMatch && userMatch;
        });
        filtered.sort((a,b) => b.dateObj - a.dateObj);
        let income = 0, expense = 0, html = '';
        filtered.forEach(f => {
            if(f.isExpense) expense += Number(f.amount); else income += Number(f.amount);
            const amountColor = f.isExpense ? 'var(--primary)' : 'var(--neon-green)';
            const sign = f.isExpense ? '- ' : '+ ';
            const badgeClass = f.isExpense ? 'gasto' : 'ingreso';
            html += `<tr><td style="font-size:0.85rem; color:#888;">${f.dateObj.toLocaleDateString()} <br> <small>${f.dateObj.toLocaleTimeString()}</small></td><td><span class="badge-fin ${badgeClass}">${f.type}</span></td><td style="font-weight:600; color:#fff;">${f.desc}</td><td style="color:#aaa;">${f.user}</td><td style="font-family:'Rajdhani'; font-size:1.1rem; font-weight:bold; color:${amountColor}">${sign}$${Number(f.amount).toLocaleString()}</td><td style="text-align:right">${(currentUser.role === 'admin' || currentUser.role === 'dev') ? `<button onclick="app.delFin('${f.id}')" style="color:#666; background:none; border:none; cursor:pointer;"><i class="fas fa-trash"></i></button>` : ''}</td></tr>`;
        });
        list.innerHTML = html || '<tr><td colspan="6" style="text-align:center; padding:20px; color:#666;">Sin movimientos</td></tr>';
        document.getElementById('fin-total-income').innerText = `$${income.toLocaleString()}`;
        document.getElementById('fin-total-expense').innerText = `$${expense.toLocaleString()}`;
        const balance = income - expense;
        const balEl = document.getElementById('fin-balance');
        if(balEl) { balEl.innerText = `$${balance.toLocaleString()}`; balEl.style.color = balance >= 0 ? 'var(--neon-orange)' : 'var(--primary)'; }
    },

    addFinanceLog: function(type, amount, desc) {
        if(!amount || isNaN(amount)) return;
        db.add("finances", { type, amount: Number(amount), desc, user: currentUser.username, date: new Date().toISOString() });
        if(document.getElementById('view-finances').classList.contains('active')) this.loadFinances();
    },

    openExpenseModal: function() { document.getElementById('modal-expense').style.display = 'flex'; },
    saveExpense: function() {
        const desc = document.getElementById('exp-desc').value, amount = document.getElementById('exp-amount').value;
        if(!desc || !amount) return showToast('error', 'Incompleto');
        this.addFinanceLog('gasto', amount, desc);
        this.logAction('Registro Gasto', `Se registró un gasto de $${amount} por "${desc}".`);
        showToast('success', 'Registrado');
        this.closeModal('modal-expense');
    },
    delFin: async function(id) {
        if(currentUser.role !== 'admin' && currentUser.role !== 'dev') return;
        const confirmed = await customConfirm("Eliminar Registro", "¿Estás seguro de que quieres eliminar este registro financiero?");
        if(confirmed) { db.delete(`finances/${id}`); showToast('success', 'Eliminado'); }
    },

    // 7. IMPRESIÓN.
    printReport: function() {
        const start = document.getElementById('filter-start').value;
        const end = document.getElementById('filter-end').value;
        const income = document.getElementById('fin-total-income').innerText;
        const expense = document.getElementById('fin-total-expense').innerText;
        const balance = document.getElementById('fin-balance').innerText;
        
        // Limpiamos los botones y estilos de color de las filas originales
        const rows = document.getElementById('finances-list').innerHTML
            .replace(/<button.*?<\/button>/g, '') // Quita botones
            .replace(/style=".*?"/g, '');         // Quita colores de la interfaz

        const printHTML = `
            <div class="print-report-pro">
                <header class="report-header">
                    <div class="report-title">
                        <h1>ATLAS GYM - REPORTE DE CAJA</h1>
                        <p>PERIODO: ${start} AL ${end}</p>
                    </div>
                    <div class="report-meta">
                        <p>Generado: ${new Date().toLocaleString()}</p>
                        <p>Usuario: ${currentUser.name}</p>
                    </div>
                </header>

                <div class="report-summary-bar">
                    <div class="sum-item"><strong>INGRESOS:</strong> ${income}</div>
                    <div class="sum-item"><strong>GASTOS:</strong> ${expense}</div>
                    <div class="sum-item"><strong>BALANCE NETO:</strong> ${balance}</div>
                </div>

                <table class="report-table-compact">
                    <thead>
                        <tr>
                            <th>FECHA</th>
                            <th>TIPO</th>
                            <th>CONCEPTO</th>
                            <th>USUARIO</th>
                            <th>MONTO</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>

                <footer class="report-footer">
                    <div class="signature-line">Firma Responsable: ${currentUser.name}</div>
                </footer>
            </div>`;
            
        document.getElementById('printable-area').innerHTML = printHTML; 
        window.print();
    },


    printReceipt: function(cliente, monto, concepto) {
        const ticketHTML = `<div class="receipt-print"><img src="Logo/ATLAS.png" style="width:60px; filter:grayscale(100%); margin-bottom:10px;"><h3>ATLAS GYM</h3><p>Recibo Oficial</p><p>${new Date().toLocaleString()}</p><br><div style="text-align:left; border-top:1px dashed #000; padding-top:10px;"><p><strong>Socio:</strong> ${cliente}</p><p><strong>Concepto:</strong> ${concepto}</p></div><div class="receipt-total">TOTAL: $${monto}</div><p><small>Atiende: ${currentUser.username}</small></p><p style="margin-top:10px; font-size:0.8rem;">¡Entrena con fuerza!</p></div>`;
        document.getElementById('printable-area').innerHTML = ticketHTML; window.print(); 
    },

    // 8. OTROS
    loadConfig: async function() {
        const c = await db.get('config/prices');
        if(c) {
            prices = c;
            const p1 = document.getElementById('conf-p1'), p3 = document.getElementById('conf-p3'), p12 = document.getElementById('conf-p12');
            if(p1) p1.value = c["1"]; if(p3) p3.value = c["3"]; if(p12) p12.value = c["12"];
        }
    },
    saveConfig: function() {
        const p1 = Number(document.getElementById('conf-p1').value), p3 = Number(document.getElementById('conf-p3').value), p12 = Number(document.getElementById('conf-p12').value);
        const newPrices = { "1":p1, "3":p3, "12":p12 };
        db.set('config/prices', newPrices);
        prices = newPrices;
        showToast('success', 'Configurado');
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

            this.currentReportData = { title, content };
            preview.innerHTML = `<h3 style="margin-top:20px; font-family:'Rajdhani'">${title}</h3>${content}`;
        },
        
        generateMemberData: function(memberType) {
            const headers = ["Código", "Nombre", "Teléfono", "Registro", "Vencimiento"];
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

            const rows = filteredMembers.map(m => [m.code, m.name, m.phone || 'N/A', new Date(m.registeredAt).toLocaleDateString(), new Date(m.expiryDate).toLocaleDateString()]);
            return { headers, rows };
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
            const headers = ["Producto", "Categoría", "Precio", "Stock Actual"];
            let filteredProducts = products;
            if (storeType === 'lowstock') {
                filteredProducts = products.filter(p => p.stock <= 3);
            }
            const rows = filteredProducts.map(p => [p.name, p.category, `$${p.price}`, p.stock]);
            return { headers, rows };
        },
        
        generateActivityData: function(start, end) {
            const headers = ["Socio", "Código", "Fecha / Hora"];
            const startDate = new Date(start);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(end);
            endDate.setHours(23, 59, 59, 999);
            
            const filteredVisits = visits.filter(v => {
                const vDate = new Date(v.date);
                return vDate >= startDate && vDate <= endDate;
            });

            const rows = filteredVisits.map(v => [v.name, v.code, new Date(v.date).toLocaleString()]);
            return { headers, rows: rows.sort((a,b) => new Date(b[2]) - new Date(a[2])) };
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
            
            const printHTML = `
                <div class="print-report-pro">
                    <header class="report-header">
                        <div class="report-title">
                            <h1>ATLAS GYM - REPORTE DE SISTEMA</h1>
                            <p>${this.currentReportData.title}</p>
                        </div>
                        <div class="report-meta">
                            <p>Generado: ${new Date().toLocaleString()}</p>
                            <p>Usuario: ${currentUser.name}</p>
                        </div>
                    </header>
                    ${this.currentReportData.content}
                    <footer class="report-footer">
                        <div class="signature-line">Firma Responsable: _________________________</div>
                    </footer>
                </div>`;
                
            document.getElementById('printable-area').innerHTML = printHTML;
            window.print();
        }
    }
};
