// Token管理：增删改查、启用禁用

let cachedTokens = [];
let currentFilter = localStorage.getItem('tokenFilter') || 'all'; // 'all', 'enabled', 'disabled'
let skipAnimation = false; // 是否跳过动画

// 移动端操作区手动收起/展开
let actionBarCollapsed = localStorage.getItem('actionBarCollapsed') === 'true';

// 存储事件监听器引用，便于清理
const eventListenerRegistry = new WeakMap();

// 注册事件监听器（便于后续清理）
function registerEventListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    
    if (!eventListenerRegistry.has(element)) {
        eventListenerRegistry.set(element, []);
    }
    eventListenerRegistry.get(element).push({ event, handler, options });
}

// 清理元素上的所有注册事件监听器
function cleanupEventListeners(element) {
    if (!element || !eventListenerRegistry.has(element)) return;
    
    const listeners = eventListenerRegistry.get(element);
    for (const { event, handler, options } of listeners) {
        element.removeEventListener(event, handler, options);
    }
    eventListenerRegistry.delete(element);
}

// 导出 Token（需要管理员密钥验证）
async function exportTokens() {
    const result = await withAdminSecret(async (secretKey) => {
        showLoading('正在导出...');
        try {
            const response = await authFetch('/admin/tokens/export', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Secret': secretKey
                }
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                // 创建下载
                const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `tokens-export-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('导出成功', 'success');
                return { success: true };
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
                showToast(data.message || '导出失败', 'error');
                return { success: false };
            }
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, '导出Token');

    if (result?.cancelled) return;
}

// 导入 Token（需要密码验证）- 打开拖拽上传弹窗
async function importTokens() {
    showImportUploadModal();
}

// 当前导入模式：'file' | 'json' | 'manual'
let currentImportTab = 'file';

// 存储导入弹窗的事件处理器引用
let importModalHandlers = null;

// 显示导入上传弹窗（支持拖拽、手动输入JSON和手动填入Token）
function showImportUploadModal() {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.id = 'importUploadModal';
    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">📥 添加/导入 Token</div>
            
            <!-- 导入方式切换标签 -->
            <div class="import-tabs">
                <button class="import-tab active" data-tab="file" onclick="switchImportTab('file')">📁 文件上传</button>
                <button class="import-tab" data-tab="json" onclick="switchImportTab('json')">📝 JSON导入</button>
                <button class="import-tab" data-tab="manual" onclick="switchImportTab('manual')">✏️ 手动填入</button>
            </div>
            
            <!-- 文件上传区域 -->
            <div class="import-tab-content" id="importTabFile">
                <div class="import-dropzone" id="importDropzone">
                    <div class="dropzone-icon">📁</div>
                    <div class="dropzone-text">拖拽文件到此处</div>
                    <div class="dropzone-hint">或点击选择文件</div>
                    <input type="file" id="importFileInput" accept=".json" style="display: none;">
                </div>
                <div class="import-file-info hidden" id="importFileInfo">
                    <div class="file-info-icon">📄</div>
                    <div class="file-info-details">
                        <div class="file-info-name" id="importFileName">-</div>
                        <div class="file-info-meta" id="importFileMeta">-</div>
                    </div>
                    <button class="btn btn-xs btn-secondary" onclick="clearImportFile()">✕</button>
                </div>
            </div>
            
            <!-- 手动输入JSON区域 -->
            <div class="import-tab-content hidden" id="importTabJson">
                <div class="form-group">
                    <label>📝 粘贴 JSON 内容</label>
                    <textarea id="importJsonInput" rows="8" placeholder='{"tokens": [...], "exportTime": "..."}'></textarea>
                </div>
                <div class="import-json-actions">
                    <button class="btn btn-sm btn-info" onclick="parseImportJson()">🔍 解析 JSON</button>
                    <span class="import-json-status" id="importJsonStatus"></span>
                </div>
            </div>
            
            <!-- 手动填入Token区域 -->
            <div class="import-tab-content hidden" id="importTabManual">
                <div class="form-group">
                    <label>🔑 Access Token <span style="color: var(--danger);">*</span></label>
                    <input type="text" id="manualAccessToken" placeholder="Access Token (必填)">
                </div>
                <div class="form-group">
                    <label>🔄 Refresh Token <span style="color: var(--danger);">*</span></label>
                    <input type="text" id="manualRefreshToken" placeholder="Refresh Token (必填)">
                </div>
                <div class="form-group">
                    <label>⏱️ 有效期(秒)</label>
                    <input type="number" id="manualExpiresIn" placeholder="有效期(秒)" value="3599">
                </div>
                <p style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 0.5rem;">💡 有效期默认3599秒(约1小时)，手动填入不需要密码验证</p>
            </div>
            
            <!-- 导入模式（仅文件上传和JSON导入时显示） -->
            <div class="form-group" id="importModeGroup">
                <label>导入模式</label>
                <select id="importMode">
                    <option value="merge">合并（保留现有，添加新的）</option>
                    <option value="replace">替换（清空现有，导入新的）</option>
                </select>
            </div>

            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeImportModal()">取消</button>
                <button class="btn btn-success" id="confirmImportBtn" onclick="confirmImportFromModal()" disabled>✅ 确认</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // 初始化当前标签
    currentImportTab = 'file';
    
    // 绑定事件（保存引用以便清理）
    const dropzone = document.getElementById('importDropzone');
    const fileInput = document.getElementById('importFileInput');
    const manualAccessToken = document.getElementById('manualAccessToken');
    const manualRefreshToken = document.getElementById('manualRefreshToken');
    
    // 创建事件处理器
    const handlers = {
        dropzoneClick: () => fileInput.click(),
        fileChange: (e) => {
            if (e.target.files[0]) {
                handleImportFile(e.target.files[0]);
            }
        },
        dragover: (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        },
        dragleave: (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        },
        drop: (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                if (file.name.endsWith('.json')) {
                    handleImportFile(file);
                } else {
                    showToast('请选择 JSON 文件', 'warning');
                }
            }
        },
        updateManualBtnState: () => {
            if (currentImportTab === 'manual') {
                const confirmBtn = document.getElementById('confirmImportBtn');
                confirmBtn.disabled = !manualAccessToken.value.trim() || !manualRefreshToken.value.trim();
            }
        },
        modalClick: (e) => { if (e.target === modal) closeImportModal(); }
    };
    
    // 保存处理器引用
    importModalHandlers = {
        modal,
        dropzone,
        fileInput,
        manualAccessToken,
        manualRefreshToken,
        handlers
    };
    
    // 绑定事件
    dropzone.addEventListener('click', handlers.dropzoneClick);
    fileInput.addEventListener('change', handlers.fileChange);
    dropzone.addEventListener('dragover', handlers.dragover);
    dropzone.addEventListener('dragleave', handlers.dragleave);
    dropzone.addEventListener('drop', handlers.drop);
    manualAccessToken.addEventListener('input', handlers.updateManualBtnState);
    manualRefreshToken.addEventListener('input', handlers.updateManualBtnState);
    modal.addEventListener('click', handlers.modalClick);
}

// 切换导入方式标签
function switchImportTab(tab) {
    currentImportTab = tab;
    
    // 更新标签状态
    document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.import-tab[data-tab="${tab}"]`).classList.add('active');
    
    // 切换内容显示
    document.getElementById('importTabFile').classList.toggle('hidden', tab !== 'file');
    document.getElementById('importTabJson').classList.toggle('hidden', tab !== 'json');
    document.getElementById('importTabManual').classList.toggle('hidden', tab !== 'manual');
    
    // 切换导入模式显示
    const importModeGroup = document.getElementById('importModeGroup');
    const confirmBtn = document.getElementById('confirmImportBtn');

    if (tab === 'manual') {
        // 手动填入模式：隐藏导入模式
        importModeGroup.classList.add('hidden');
        // 更新按钮状态
        const accessToken = document.getElementById('manualAccessToken').value.trim();
        const refreshToken = document.getElementById('manualRefreshToken').value.trim();
        confirmBtn.disabled = !accessToken || !refreshToken;
        confirmBtn.textContent = '✅ 添加';
    } else {
        // 文件上传或JSON导入模式：显示导入模式
        importModeGroup.classList.remove('hidden');
        confirmBtn.textContent = '✅ 确认导入';

        // 清除之前的数据
        if (tab === 'file') {
            // 切换到文件上传时，清除JSON输入和手动输入
            document.getElementById('importJsonInput').value = '';
            document.getElementById('importJsonStatus').textContent = '';
            document.getElementById('manualAccessToken').value = '';
            document.getElementById('manualRefreshToken').value = '';
            document.getElementById('manualExpiresIn').value = '3599';
            // 按钮状态由文件选择决定
            confirmBtn.disabled = !pendingImportData;
        } else if (tab === 'json') {
            // 切换到JSON输入时，清除文件选择和手动输入
            clearImportFile();
            document.getElementById('manualAccessToken').value = '';
            document.getElementById('manualRefreshToken').value = '';
            document.getElementById('manualExpiresIn').value = '3599';
            // 按钮状态由JSON解析决定
            confirmBtn.disabled = !pendingImportData;
        }
    }
}

// 智能查找字段值（不分大小写，包含匹配）
function findFieldByKeyword(obj, keyword) {
    if (!obj || typeof obj !== 'object') return undefined;
    const lowerKeyword = keyword.toLowerCase();
    for (const key of Object.keys(obj)) {
        if (key.toLowerCase().includes(lowerKeyword)) {
            return obj[key];
        }
    }
    return undefined;
}

// 智能解析单个 Token 对象
function smartParseToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'object') return null;
    
    // 必需字段：包含 refresh 的认为是 refresh_token，包含 project 的认为是 projectId
    const refresh_token = findFieldByKeyword(rawToken, 'refresh');
    const projectId = findFieldByKeyword(rawToken, 'project');
    
    // 必须同时包含这两个字段
    if (!refresh_token || !projectId) return null;
    
    // 构建标准化的 token 对象
    const token = { refresh_token, projectId };
    
    // 可选字段自动获取
    const access_token = findFieldByKeyword(rawToken, 'access');
    const email = findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail');
    const expires_in = findFieldByKeyword(rawToken, 'expire');
    const enable = findFieldByKeyword(rawToken, 'enable');
    const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp');
    const hasQuota = findFieldByKeyword(rawToken, 'quota');
    
    if (access_token) token.access_token = access_token;
    if (email) token.email = email;
    if (expires_in !== undefined) token.expires_in = parseInt(expires_in) || 3599;
    if (enable !== undefined) token.enable = enable === true || enable === 'true' || enable === 1;
    if (timestamp) token.timestamp = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    if (hasQuota !== undefined) token.hasQuota = hasQuota === true || hasQuota === 'true' || hasQuota === 1;
    
    return token;
}

// 智能解析导入数据（支持多种格式）
function smartParseImportData(jsonText) {
    let data;
    let cleanText = jsonText.trim();
    
    // 预处理：移除尾随逗号（常见的 JSON 格式错误）
    cleanText = cleanText.replace(/,(\s*[}\]])/g, '$1');
    
    try {
        data = JSON.parse(cleanText);
    } catch (e) {
        // 尝试处理多个 JSON 对象（用户可能粘贴了多个对象，没有用数组包裹）
        try {
            // 尝试将多个对象包装成数组
            // 匹配 }{  或 }\n{ 的情况，替换为 },{
            const arrayText = '[' + cleanText.replace(/\}\s*\{/g, '},{') + ']';
            data = JSON.parse(arrayText);
        } catch (e2) {
            return { success: false, message: `JSON 解析错误: ${e.message}` };
        }
    }
    
    // 识别数据结构：数组或对象中的数组
    let tokensArray = [];
    if (Array.isArray(data)) {
        tokensArray = data;
    } else if (typeof data === 'object' && data !== null) {
        // 查找任何包含数组的字段
        for (const key of Object.keys(data)) {
            if (Array.isArray(data[key])) {
                tokensArray = data[key];
                break;
            }
        }
        // 如果没找到数组，尝试作为单个 token 解析
        if (tokensArray.length === 0) {
            const single = smartParseToken(data);
            if (single) tokensArray = [data];
        }
    }
    
    if (tokensArray.length === 0) {
        return { success: false, message: '未找到有效数据，请确保包含 refresh_token 和 projectId' };
    }
    
    // 解析每个 token
    const validTokens = [];
    let invalidCount = 0;
    for (const raw of tokensArray) {
        const parsed = smartParseToken(raw);
        if (parsed) {
            validTokens.push(parsed);
        } else {
            invalidCount++;
        }
    }
    
    if (validTokens.length === 0) {
        return { success: false, message: `所有 ${tokensArray.length} 条数据都缺少必需字段 (refresh_token 和 projectId)` };
    }
    
    const message = invalidCount > 0
        ? `解析成功：${validTokens.length} 个有效，${invalidCount} 个无效`
        : `解析成功：${validTokens.length} 个 Token`;
    
    return { success: true, tokens: validTokens, message };
}

// 解析手动输入的JSON
function parseImportJson() {
    const jsonInput = document.getElementById('importJsonInput');
    const statusEl = document.getElementById('importJsonStatus');
    const confirmBtn = document.getElementById('confirmImportBtn');
    
    const jsonText = jsonInput.value.trim();
    if (!jsonText) {
        statusEl.textContent = '❌ 请输入 JSON 内容';
        statusEl.className = 'import-json-status error';
        pendingImportData = null;
        confirmBtn.disabled = true;
        return;
    }
    
    const result = smartParseImportData(jsonText);
    
    if (result.success) {
        // 保存待导入数据（转换为标准格式）
        pendingImportData = { tokens: result.tokens };
        statusEl.textContent = `✅ ${result.message}`;
        statusEl.className = 'import-json-status success';
        confirmBtn.disabled = false;
    } else {
        statusEl.textContent = `❌ ${result.message}`;
        statusEl.className = 'import-json-status error';
        pendingImportData = null;
        confirmBtn.disabled = true;
    }
}

// 当前待导入的数据
let pendingImportData = null;

// 处理导入文件（使用智能解析）
async function handleImportFile(file) {
    try {
        const text = await file.text();
        const result = smartParseImportData(text);
        
        if (!result.success) {
            showToast(result.message, 'error');
            return;
        }
        
        // 保存待导入数据（转换为标准格式）
        pendingImportData = { tokens: result.tokens };
        
        // 更新UI显示文件信息
        const dropzone = document.getElementById('importDropzone');
        const fileInfo = document.getElementById('importFileInfo');
        const fileName = document.getElementById('importFileName');
        const fileMeta = document.getElementById('importFileMeta');
        const confirmBtn = document.getElementById('confirmImportBtn');
        
        dropzone.classList.add('hidden');
        fileInfo.classList.remove('hidden');
        fileName.textContent = file.name;
        fileMeta.textContent = result.message;
        confirmBtn.disabled = false;
        
    } catch (error) {
        showToast('读取文件失败: ' + error.message, 'error');
    }
}

// 清除已选文件
function clearImportFile() {
    pendingImportData = null;
    
    const dropzone = document.getElementById('importDropzone');
    const fileInfo = document.getElementById('importFileInfo');
    const fileInput = document.getElementById('importFileInput');
    const confirmBtn = document.getElementById('confirmImportBtn');
    
    dropzone.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    fileInput.value = '';
    confirmBtn.disabled = true;
}

// 关闭导入弹窗
function closeImportModal() {
    // 清理事件监听器
    if (importModalHandlers) {
        const { modal, dropzone, fileInput, manualAccessToken, manualRefreshToken, handlers } = importModalHandlers;
        
        if (dropzone) {
            dropzone.removeEventListener('click', handlers.dropzoneClick);
            dropzone.removeEventListener('dragover', handlers.dragover);
            dropzone.removeEventListener('dragleave', handlers.dragleave);
            dropzone.removeEventListener('drop', handlers.drop);
        }
        if (fileInput) {
            fileInput.removeEventListener('change', handlers.fileChange);
        }
        if (manualAccessToken) {
            manualAccessToken.removeEventListener('input', handlers.updateManualBtnState);
        }
        if (manualRefreshToken) {
            manualRefreshToken.removeEventListener('input', handlers.updateManualBtnState);
        }
        if (modal) {
            modal.removeEventListener('click', handlers.modalClick);
        }
        
        importModalHandlers = null;
    }
    
    const modal = document.getElementById('importUploadModal');
    if (modal) {
        modal.remove();
    }
    pendingImportData = null;
}

// 从弹窗确认导入/添加
async function confirmImportFromModal() {
    // 手动填入模式
    if (currentImportTab === 'manual') {
        const accessToken = document.getElementById('manualAccessToken').value.trim();
        const refreshToken = document.getElementById('manualRefreshToken').value.trim();
        const expiresIn = parseInt(document.getElementById('manualExpiresIn').value) || 3599;

        if (!accessToken || !refreshToken) {
            showToast('请填写完整的Token信息', 'warning');
            return;
        }

        showLoading('正在添加Token...');
        try {
            const response = await authFetch('/admin/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn })
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                closeImportModal();
                showToast('Token添加成功', 'success');
                loadTokens();
            } else {
                showToast(data.message || '添加失败', 'error');
            }
        } catch (error) {
            hideLoading();
            showToast('添加失败: ' + error.message, 'error');
        }
        return;
    }

    // 文件上传或JSON导入模式
    if (!pendingImportData) {
        showToast('请先选择文件或解析JSON', 'warning');
        return;
    }

    const mode = document.getElementById('importMode').value;

    const result = await withAdminSecret(async (secretKey) => {
        showLoading('正在导入...');
        try {
            const response = await authFetch('/admin/tokens/import', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Secret': secretKey
                },
                body: JSON.stringify({ data: pendingImportData, mode })
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                closeImportModal();
                showToast(data.message, 'success');
                loadTokens();
                return { success: true };
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
                showToast(data.message || '导入失败', 'error');
                return { success: false };
            }
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, '导入Token');

    if (result?.cancelled) return;
}

// 密码输入提示框
function showPasswordPrompt(message) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal form-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">🔐 密码验证</div>
                <p>${message}</p>
                <div class="form-group">
                    <input type="password" id="promptPassword" placeholder="请输入密码">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="promptCancelBtn">取消</button>
                    <button class="btn btn-success" id="promptConfirmBtn">确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        const passwordInput = document.getElementById('promptPassword');
        const confirmBtn = document.getElementById('promptConfirmBtn');
        const cancelBtn = document.getElementById('promptCancelBtn');
        
        // 清理函数
        const cleanup = () => {
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            passwordInput.removeEventListener('keydown', handleKeydown);
            modal.removeEventListener('click', handleModalClick);
            modal.remove();
        };
        
        const handleConfirm = () => {
            const password = passwordInput.value;
            cleanup();
            resolve(password || null);
        };
        
        const handleCancel = () => {
            cleanup();
            resolve(null);
        };
        
        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                handleConfirm();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };
        
        const handleModalClick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(null);
            }
        };
        
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        passwordInput.addEventListener('keydown', handleKeydown);
        modal.addEventListener('click', handleModalClick);
        
        passwordInput.focus();
    });
}

// 手动切换操作区显示/隐藏（暴露到全局）
window.toggleActionBar = function() {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');
    
    if (!actionBar || !toggleBtn) return;
    
    actionBarCollapsed = !actionBarCollapsed;
    localStorage.setItem('actionBarCollapsed', actionBarCollapsed);
    
    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '展开操作按钮';
    } else {
        actionBar.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
        toggleBtn.title = '收起操作按钮';
    }
}

// 初始化操作区状态（恢复保存的收起/展开状态）
function initActionBarState() {
    const actionBar = document.getElementById('actionBar');
    const toggleBtn = document.getElementById('actionToggleBtn');
    
    if (!actionBar || !toggleBtn) return;
    
    // 恢复保存的状态
    if (actionBarCollapsed) {
        actionBar.classList.add('collapsed');
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '展开操作按钮';
    }
}

// 页面加载后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initActionBarState);
} else {
    initActionBarState();
}

// 初始化筛选状态
function initFilterState() {
    const savedFilter = localStorage.getItem('tokenFilter') || 'all';
    currentFilter = savedFilter;
    updateFilterButtonState(savedFilter);
}

// 更新筛选按钮状态
function updateFilterButtonState(filter) {
    document.querySelectorAll('.stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalTokens', 'enabled': 'enabledTokens', 'disabled': 'disabledTokens' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// 筛选 Token
function filterTokens(filter) {
    currentFilter = filter;
    localStorage.setItem('tokenFilter', filter); // 持久化筛选状态
    
    updateFilterButtonState(filter);
    
    // 重新渲染
    renderTokens(cachedTokens);
}

async function loadTokens() {
    try {
        const response = await authFetch('/admin/tokens');
        
        const data = await response.json();
        if (data.success) {
            renderTokens(data.data);
        } else {
            showToast('加载失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载Token失败: ' + error.message, 'error');
    }
}

// 正在刷新的 Token 集合（使用 tokenId）
const refreshingTokens = new Set();

// 限制 refreshingTokens 集合大小，防止内存泄漏
function cleanupRefreshingTokens() {
    // 如果集合过大，清空它（正常情况下不应该有太多同时刷新的 token）
    if (refreshingTokens.size > 100) {
        refreshingTokens.clear();
    }
}

function renderTokens(tokens) {
    // 只在首次加载时更新缓存
    if (tokens !== cachedTokens) {
        cachedTokens = tokens;
    }
    
    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('enabledTokens').textContent = tokens.filter(t => t.enable).length;
    document.getElementById('disabledTokens').textContent = tokens.filter(t => !t.enable).length;
    
    // 根据筛选条件过滤
    let filteredTokens = tokens;
    if (currentFilter === 'enabled') {
        filteredTokens = tokens.filter(t => t.enable);
    } else if (currentFilter === 'disabled') {
        filteredTokens = tokens.filter(t => !t.enable);
    }
    
    const tokenList = document.getElementById('tokenList');
    if (filteredTokens.length === 0) {
        const emptyText = currentFilter === 'all' ? '暂无Token' :
                          currentFilter === 'enabled' ? '暂无启用的Token' : '暂无禁用的Token';
        const emptyHint = currentFilter === 'all' ? '点击上方OAuth按钮添加Token' : '点击上方"总数"查看全部';
        tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }
    
    tokenList.innerHTML = filteredTokens.map((token, index) => {
        // 使用安全的 tokenId 替代 refresh_token
        const tokenId = token.id;
        const isRefreshing = refreshingTokens.has(tokenId);
        const cardId = tokenId.substring(0, 8);
        
        // 计算在原始列表中的序号（基于添加顺序）
        const originalIndex = cachedTokens.findIndex(t => t.id === token.id);
        const tokenNumber = originalIndex + 1;
        
        // 转义所有用户数据防止 XSS
        const safeTokenId = escapeJs(tokenId);
        const safeProjectId = escapeHtml(token.projectId || '');
        const safeEmail = escapeHtml(token.email || '');
        const safeProjectIdJs = escapeJs(token.projectId || '');
        const safeEmailJs = escapeJs(token.email || '');
        
        return `
        <div class="token-card ${!token.enable ? 'disabled' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipAnimation ? 'no-animation' : ''}" id="card-${escapeHtml(cardId)}">
            <div class="token-header">
                <div class="token-header-left">
                    <span class="status ${token.enable ? 'enabled' : 'disabled'}">
                        ${token.enable ? '✅ 启用' : '❌ 禁用'}
                    </span>
                    <button class="btn-icon token-refresh-btn ${isRefreshing ? 'loading' : ''}" id="refresh-btn-${escapeHtml(cardId)}" onclick="manualRefreshToken('${safeTokenId}')" title="刷新Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>
                </div>
                <div class="token-header-right">
                    <button class="btn-icon" onclick="showTokenDetail('${safeTokenId}')" title="编辑">✏️</button>
                    <span class="token-id">#${tokenNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'projectId', '${safeProjectIdJs}')" title="点击编辑">
                    <span class="info-label">📦</span>
                    <span class="info-value sensitive-info">${safeProjectId || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeTokenId}', 'email', '${safeEmailJs}')" title="点击编辑">
                    <span class="info-label">📧</span>
                    <span class="info-value sensitive-info">${safeEmail || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
            </div>
            <div class="token-id-row" title="Token ID: ${escapeHtml(tokenId)}">
                <span class="token-id-label">🔑</span>
                <span class="token-id-value">${escapeHtml(tokenId.length > 24 ? tokenId.substring(0, 12) + '...' + tokenId.substring(tokenId.length - 8) : tokenId)}</span>
            </div>
            <div class="token-quota-inline" id="quota-inline-${escapeHtml(cardId)}">
                <div class="quota-inline-header" onclick="toggleQuotaExpand('${escapeJs(cardId)}', '${safeTokenId}')">
                    <span class="quota-inline-summary" id="quota-summary-${escapeHtml(cardId)}">📊 加载中...</span>
                    <span class="quota-inline-toggle" id="quota-toggle-${escapeHtml(cardId)}">▼</span>
                </div>
                <div class="quota-inline-detail hidden" id="quota-detail-${escapeHtml(cardId)}"></div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info btn-xs" onclick="showQuotaModal('${safeTokenId}')" title="查看额度">📊 详情</button>
                <button class="btn ${token.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleToken('${safeTokenId}', ${!token.enable})" title="${token.enable ? '禁用' : '启用'}">
                    ${token.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteToken('${safeTokenId}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `}).join('');
    
    filteredTokens.forEach(token => {
        loadTokenQuotaSummary(token.id);
    });
    
    updateSensitiveInfoDisplay();
    
    // 重置动画跳过标志
    skipAnimation = false;
}

// 手动刷新 Token（使用 tokenId）
async function manualRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) {
        showToast('该 Token 正在刷新中', 'warning');
        return;
    }
    await autoRefreshToken(tokenId);
}

// 刷新指定 Token（手动触发，使用 tokenId）
async function autoRefreshToken(tokenId) {
    if (refreshingTokens.has(tokenId)) return;
    
    refreshingTokens.add(tokenId);
    const cardId = tokenId.substring(0, 8);
    
    // 更新 UI 显示刷新中状态
    const card = document.getElementById(`card-${cardId}`);
    const refreshBtn = document.getElementById(`refresh-btn-${cardId}`);
    if (card) {
        card.classList.remove('refresh-failed');
        card.classList.add('refreshing');
    }
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        refreshBtn.textContent = '🔄';
    }
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/refresh`, {
            method: 'POST'
        });
        
        const data = await response.json();
        if (data.success) {
            showToast('Token 已自动刷新', 'success');
            // 刷新成功后重新加载列表
            refreshingTokens.delete(tokenId);
            if (card) card.classList.remove('refreshing');
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
            loadTokens();
        } else {
            showToast(`Token 刷新失败: ${data.message || '未知错误'}`, 'error');
            refreshingTokens.delete(tokenId);
            // 更新 UI 显示刷新失败
            if (card) {
                card.classList.remove('refreshing');
                card.classList.add('refresh-failed');
            }
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
                refreshBtn.textContent = '🔄';
            }
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast(`Token 刷新失败: ${error.message}`, 'error');
        }
        refreshingTokens.delete(tokenId);
        // 更新 UI 显示刷新失败
        if (card) {
            card.classList.remove('refreshing');
            card.classList.add('refresh-failed');
        }
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('loading');
            refreshBtn.textContent = '🔄';
        }
    }
}

// showManualModal 已合并到 showImportUploadModal 中
function showManualModal() {
    // 打开导入弹窗并切换到手动填入标签
    showImportUploadModal();
    // 延迟切换标签，确保DOM已渲染
    setTimeout(() => switchImportTab('manual'), 0);
}

function editField(event, tokenId, field, currentValue) {
    event.stopPropagation();
    const row = event.currentTarget;
    const valueSpan = row.querySelector('.info-value');

    if (row.querySelector('input')) return;

    // 如果是邮箱且包含掩码，先尝试获取完整数据
    if (field === 'email' && (currentValue.includes('****') || currentValue === '点击设置')) {
        handleSensitiveField(row, tokenId, field, valueSpan);
        return;
    }

    startEditing(row, tokenId, field, currentValue, valueSpan);
}

// 处理敏感字段的查看/编辑
async function handleSensitiveField(row, tokenId, field, valueSpan) {
    const result = await withAdminSecret(async (secretKey) => {
        try {
            // 这里我们使用 GET /tokens/sensitive 接口或者直接用密钥去获取单个 token 的详情
            // 简单起见，我们假设可以通过密钥获取完整信息的接口
            // 由于目前后端 GET /tokens 已经脱敏，我们需要一个新的接口或者在这里直接允许用户输入新的覆盖
            // 为了更好的体验，我们实现一个获取完整信息的逻辑

            // 使用 /admin/tokens/sensitive 接口获取所有数据然后查找（不够高效但可行）
            // 或者我们可以修改后端支持用密钥获取单个完整 token
            // 这里为了简化，我们先尝试获取完整列表找到对应的

            showLoading('获取完整信息...');
            const response = await authFetch('/admin/tokens/sensitive', {
                headers: {
                    'X-Admin-Secret': secretKey
                }
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                const token = data.data.find(t => t.id === tokenId);
                if (token) {
                    return { success: true, value: token[field] };
                }
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
            }
            return { success: false };
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, '查看/编辑敏感信息');

    if (result && result.success && result.value !== undefined) {
        // 获取成功，开始编辑
        startEditing(row, tokenId, field, result.value, valueSpan);
    } else if (result && result.cancelled) {
        // 取消
    } else {
        // 获取失败，询问是否直接覆盖
        const confirm = await showConfirm('无法获取完整信息，是否直接输入新值覆盖？', '无法获取原值');
        if (confirm) {
            startEditing(row, tokenId, field, '', valueSpan);
        }
    }
}

function startEditing(row, tokenId, field, currentValue, valueSpan) {
    const fieldLabels = { projectId: 'Project ID', email: '邮箱' };

    const input = document.createElement('input');
    input.type = field === 'email' ? 'email' : 'text';
    input.value = currentValue === '点击设置' ? '' : currentValue;
    input.className = 'inline-edit-input';
    input.placeholder = `输入${fieldLabels[field]}`;

    valueSpan.style.display = 'none';
    row.insertBefore(input, valueSpan.nextSibling);
    input.focus();
    input.select();

    const save = async () => {
        const newValue = input.value.trim();
        input.disabled = true;

        const result = await withAdminSecret(async (secretKey) => {
            try {
                const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Secret': secretKey
                    },
                    body: JSON.stringify({ [field]: newValue })
                });

                const data = await response.json();
                if (data.success) {
                    showToast('已保存', 'success');
                    loadTokens();
                    return { success: true };
                } else {
                    if (data.requireAdminSecret) {
                        throw { message: '管理员密钥验证失败', status: 403 };
                    }
                    showToast(data.message || '保存失败', 'error');
                    cancel();
                    return { success: false };
                }
            } catch (error) {
                showToast('保存失败: ' + error.message, 'error');
                cancel();
                throw error;
            }
        }, '修改Token信息');

        if (result?.cancelled) cancel();
    };

    const cancel = () => {
        input.remove();
        valueSpan.style.display = '';
    };

    // ... 事件监听代码复用 ...
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== input) {
                if (input.value.trim() !== (currentValue === '点击设置' ? '' : currentValue)) {
                    save();
                } else {
                    cancel();
                }
            }
        }, 100);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });
}

function showTokenDetail(tokenId) {
    const token = cachedTokens.find(t => t.id === tokenId);
    if (!token) {
        showToast('Token不存在', 'error');
        return;
    }
    
    // 转义所有用户数据防止 XSS
    const safeTokenId = escapeJs(tokenId);
    const safeProjectId = escapeHtml(token.projectId || '');
    const safeEmail = escapeHtml(token.email || '');
    const updatedAtStr = escapeHtml(token.timestamp ? new Date(token.timestamp).toLocaleString('zh-CN') : '未知');
    
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">📝 Token详情</div>
            <div class="form-group compact">
                <label>🔑 Token ID</label>
                <div class="token-display">${escapeHtml(tokenId)}</div>
            </div>
            <div class="form-group compact">
                <label>📦 Project ID</label>
                <input type="text" id="editProjectId" value="${safeProjectId}" placeholder="项目ID">
            </div>
            <div class="form-group compact">
                <label>📧 邮箱</label>
                <input type="email" id="editEmail" value="${safeEmail}" placeholder="账号邮箱">
            </div>
            <div class="form-group compact">
                <label>🕒 最后更新时间</label>
                <input type="text" value="${updatedAtStr}" readonly style="background: var(--bg); cursor: not-allowed;">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="saveTokenDetail('${safeTokenId}')">💾 保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function saveTokenDetail(tokenId) {
    const projectId = document.getElementById('editProjectId').value.trim();
    const email = document.getElementById('editEmail').value.trim();

    const result = await withAdminSecret(async (secretKey) => {
        showLoading('保存中...');
        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Secret': secretKey
                },
                body: JSON.stringify({ projectId, email })
            });

            const data = await response.json();
            hideLoading();
            if (data.success) {
                document.querySelector('.form-modal').remove();
                showToast('保存成功', 'success');
                loadTokens();
                return { success: true };
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
                showToast(data.message || '保存失败', 'error');
                return { success: false };
            }
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, '保存Token详情');

    if (result?.cancelled) return;
}

async function toggleToken(tokenId, enable) {
    const action = enable ? '启用' : '禁用';
    const confirmed = await showConfirm(`确定要${action}这个Token吗？`, `${action}确认`);
    if (!confirmed) return;

    // 启用/禁用操作均需要管理员密钥验证
    const result = await withAdminSecret(async (secretKey) => {
        showLoading(`正在${action}...`);
        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Secret': secretKey
                },
                body: JSON.stringify({ enable })
            });

            const data = await response.json();
            hideLoading();
            if (data.success) {
                showToast(`已${action}`, 'success');
                skipAnimation = true;
                loadTokens();
                return { success: true };
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
                showToast(data.message || '操作失败', 'error');
                return { success: false };
            }
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, `${action}Token`);

    if (result?.cancelled) return;
}

async function deleteToken(tokenId) {
    const confirmed = await showConfirm('删除后无法恢复，确定删除？', '⚠️ 删除确认');
    if (!confirmed) return;

    // 需要管理员密钥验证
    const result = await withAdminSecret(async (secretKey) => {
        showLoading('正在删除...');
        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
                method: 'DELETE',
                headers: {
                    'X-Admin-Secret': secretKey
                }
            });

            const data = await response.json();
            hideLoading();
            if (data.success) {
                showToast('已删除', 'success');
                loadTokens();
                return { success: true };
            } else {
                if (data.requireAdminSecret) {
                    throw { message: '管理员密钥验证失败', status: 403 };
                }
                showToast(data.message || '删除失败', 'error');
                return { success: false };
            }
        } catch (error) {
            hideLoading();
            throw error;
        }
    }, '删除Token');

    if (result?.cancelled) return;
}
