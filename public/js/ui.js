// UI组件：Toast、Modal、Loading

// Toast 管理器 - 限制同时显示的 toast 数量
const toastManager = {
    maxToasts: 5,
    activeToasts: [],
    
    add(toast) {
        this.activeToasts.push(toast);
        // 如果超过最大数量，移除最旧的
        while (this.activeToasts.length > this.maxToasts) {
            const oldest = this.activeToasts.shift();
            if (oldest && oldest.parentNode) {
                oldest.remove();
            }
        }
    },
    
    remove(toast) {
        const index = this.activeToasts.indexOf(toast);
        if (index > -1) {
            this.activeToasts.splice(index, 1);
        }
    },
    
    clear() {
        for (const toast of this.activeToasts) {
            if (toast && toast.parentNode) {
                toast.remove();
            }
        }
        this.activeToasts = [];
    }
};

function showToast(message, type = 'info', title = '') {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const titles = { success: '成功', error: '错误', warning: '警告', info: '提示' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    // 转义用户输入防止 XSS
    const safeTitle = escapeHtml(title || titles[type]);
    const safeMessage = escapeHtml(message);
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${safeTitle}</div>
            <div class="toast-message">${safeMessage}</div>
        </div>
    `;
    document.body.appendChild(toast);
    toastManager.add(toast);
    
    // 使用 requestAnimationFrame 优化动画性能
    const removeToast = () => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            toastManager.remove(toast);
            if (toast.parentNode) {
                toast.remove();
            }
        }, 300);
    };
    
    setTimeout(removeToast, 3000);
}

function showConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        // 转义用户输入防止 XSS
        const safeTitle = escapeHtml(title);
        const safeMessage = escapeHtml(message);
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">${safeTitle}</div>
                <div class="modal-message">${safeMessage}</div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="confirmCancelBtn">取消</button>
                    <button class="btn btn-danger" id="confirmOkBtn">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        const cancelBtn = modal.querySelector('#confirmCancelBtn');
        const okBtn = modal.querySelector('#confirmOkBtn');
        
        // 清理函数
        const cleanup = () => {
            cancelBtn.removeEventListener('click', handleCancel);
            okBtn.removeEventListener('click', handleOk);
            modal.removeEventListener('click', handleModalClick);
            modal.remove();
        };
        
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };
        
        const handleOk = () => {
            cleanup();
            resolve(true);
        };
        
        const handleModalClick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(false);
            }
        };
        
        cancelBtn.addEventListener('click', handleCancel);
        okBtn.addEventListener('click', handleOk);
        modal.addEventListener('click', handleModalClick);
    });
}

// 存储当前 loading overlay 引用
let currentLoadingOverlay = null;

function showLoading(text = '处理中...') {
    // 如果已有 loading，先移除
    hideLoading();
    
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loadingOverlay';
    // 转义用户输入防止 XSS
    const safeText = escapeHtml(text);
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${safeText}</div>`;
    document.body.appendChild(overlay);
    currentLoadingOverlay = overlay;
}

function hideLoading() {
    if (currentLoadingOverlay && currentLoadingOverlay.parentNode) {
        currentLoadingOverlay.remove();
    }
    currentLoadingOverlay = null;
    
    // 备用清理：通过 ID 查找
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

function switchTab(tab, saveState = true) {
    // 更新html元素的class以防止闪烁
    document.documentElement.classList.remove('tab-settings', 'tab-logs');
    if (tab === 'settings') {
        document.documentElement.classList.add('tab-settings');
    } else if (tab === 'logs') {
        document.documentElement.classList.add('tab-logs');
    }
    
    // 移除所有tab的active状态
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    
    // 找到对应的tab按钮并激活
    const targetTab = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
    }
    
    const tokensPage = document.getElementById('tokensPage');
    const settingsPage = document.getElementById('settingsPage');
    const logsPage = document.getElementById('logsPage');
    
    // 隐藏所有页面并移除动画类
    tokensPage.classList.add('hidden');
    tokensPage.classList.remove('page-enter');
    settingsPage.classList.add('hidden');
    settingsPage.classList.remove('page-enter');
    if (logsPage) {
        logsPage.classList.add('hidden');
        logsPage.classList.remove('page-enter');
    }
    
    // 清理日志页面的自动刷新（如果离开日志页面）
    if (tab !== 'logs' && typeof cleanupLogsPage === 'function') {
        cleanupLogsPage();
    }
    
    // 显示对应页面并添加入场动画
    if (tab === 'tokens') {
        tokensPage.classList.remove('hidden');
        // 触发重排以重新播放动画
        void tokensPage.offsetWidth;
        tokensPage.classList.add('page-enter');
        // 进入 Token 页面时，从后端读取最新 token 列表
        if (typeof loadTokens === 'function' && isLoggedIn) {
            loadTokens();
        }
    } else if (tab === 'settings') {
        settingsPage.classList.remove('hidden');
        // 触发重排以重新播放动画
        void settingsPage.offsetWidth;
        settingsPage.classList.add('page-enter');
        loadConfig();
    } else if (tab === 'logs') {
        if (logsPage) {
            logsPage.classList.remove('hidden');
            // 触发重排以重新播放动画
            void logsPage.offsetWidth;
            logsPage.classList.add('page-enter');
            // 进入日志页面时加载日志
            if (typeof initLogsPage === 'function') {
                initLogsPage();
            }
        }
    }
    
    // 保存当前Tab状态到localStorage
    if (saveState) {
        localStorage.setItem('currentTab', tab);
    }
}

// 恢复Tab状态
function restoreTabState() {
    const savedTab = localStorage.getItem('currentTab');
    if (savedTab && (savedTab === 'tokens' || savedTab === 'settings' || savedTab === 'logs')) {
        switchTab(savedTab, false);
    }
}

// ==================== 管理员密钥验证 ====================
// 存储管理员密钥（会话级别，不持久化）
let cachedAdminSecretKey = null;

/**
 * 获取管理员密钥（如果已缓存则直接返回）
 * @returns {string|null}
 */
function getCachedAdminSecret() {
    return cachedAdminSecretKey;
}

/**
 * 清除缓存的管理员密钥
 */
function clearAdminSecretCache() {
    cachedAdminSecretKey = null;
}

/**
 * 显示管理员密钥输入弹窗
 * @param {string} action - 操作描述（如："删除Token"、"导出数据"）
 * @returns {Promise<string|null>} - 返回输入的密钥，取消返回 null
 */
function requestAdminSecret(action = '执行敏感操作') {
    return new Promise((resolve) => {
        // 如果已有缓存的密钥，直接返回
        if (cachedAdminSecretKey) {
            resolve(cachedAdminSecretKey);
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'modal';
        const safeAction = escapeHtml(action);
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 400px;">
                <div class="modal-title">🔐 管理员密钥验证</div>
                <div class="modal-message" style="margin-bottom: 15px;">
                    ${safeAction} 需要验证管理员密钥
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <input type="password" id="adminSecretInput" class="input"
                           placeholder="请输入管理员密钥"
                           style="width: 100%; padding: 10px; font-family: monospace;">
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
                        <input type="checkbox" id="rememberSecretCheckbox">
                        <span>本次会话记住密钥</span>
                    </label>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="secretCancelBtn">取消</button>
                    <button class="btn btn-primary" id="secretOkBtn">验证</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = modal.querySelector('#adminSecretInput');
        const checkbox = modal.querySelector('#rememberSecretCheckbox');
        const cancelBtn = modal.querySelector('#secretCancelBtn');
        const okBtn = modal.querySelector('#secretOkBtn');

        // 自动聚焦输入框
        setTimeout(() => input.focus(), 100);

        const cleanup = () => {
            cancelBtn.removeEventListener('click', handleCancel);
            okBtn.removeEventListener('click', handleOk);
            input.removeEventListener('keydown', handleKeydown);
            modal.removeEventListener('click', handleModalClick);
            modal.remove();
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        const handleOk = () => {
            const secretKey = input.value.trim();
            if (!secretKey) {
                showToast('请输入管理员密钥', 'warning');
                input.focus();
                return;
            }
            // 如果勾选了记住，缓存密钥
            if (checkbox.checked) {
                cachedAdminSecretKey = secretKey;
            }
            cleanup();
            resolve(secretKey);
        };

        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                handleOk();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };

        const handleModalClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        cancelBtn.addEventListener('click', handleCancel);
        okBtn.addEventListener('click', handleOk);
        input.addEventListener('keydown', handleKeydown);
        modal.addEventListener('click', handleModalClick);
    });
}

/**
 * 包装需要管理员密钥的请求
 * @param {Function} requestFn - 请求函数，接收 secretKey 参数
 * @param {string} action - 操作描述
 * @returns {Promise<any>}
 */
async function withAdminSecret(requestFn, action = '执行操作') {
    // 第一次尝试（尝试获取密钥，可能是缓存的）
    let secretKey = await requestAdminSecret(action);
    if (!secretKey) {
        return { cancelled: true };
    }

    try {
        const result = await requestFn(secretKey);
        return result;
    } catch (error) {
        // 如果是密钥验证失败（403 或特定消息），清除缓存并允许重试
        if (error.message?.includes('管理员密钥') || error.status === 403) {

            // 如果是因为使用了缓存的错误密钥，我们清除缓存并告诉用户
            if (cachedAdminSecretKey) {
                // 如果是缓存的密钥错了，清除缓存，自动重试一次输入
                clearAdminSecretCache();

                // 提示用户密钥错误，请重试
                showToast('密钥无效，请重新输入', 'warning');

                // 递归调用自身，因为 requestAdminSecret 现在不会使用缓存了，会弹窗
                return withAdminSecret(requestFn, action);
            } else {
                 // 如果是刚输入的就错了，也允许重试
                 clearAdminSecretCache();
                 showToast('密钥错误，请重新输入', 'error');
                 return withAdminSecret(requestFn, action);
            }
        }
        throw error;
    }
}

