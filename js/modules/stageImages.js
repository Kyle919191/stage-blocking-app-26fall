// stageImages.js - 舞台图管理模块（图片库 + 场次配置）
import { BlockingApp, stageLibraryRef, sceneStageMapRef } from '../services/firebase.js';
import { showStatus } from '../utils/helpers.js';
import { log, logError } from '../utils/logger.js';

// 当前 Tab 状态
let currentTab = 'library';

// 场次舞台图配置（内存缓存）
let sceneStageMap = {};

// 从场景ID解析幕号
export function getActFromSceneId(sceneId) {
    return sceneId.split('-')[0];
}

// 辅助函数：File 转 Base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// 生成唯一 key
function generateImageKey(name) {
    const timestamp = Date.now();
    const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    return `${safeName}_${timestamp}`;
}

// 加载图片库数据（从 Firebase，并与本地同步）
export async function loadStageLibrary() {
    try {
        const snapshot = await stageLibraryRef.once('value');
        const firebaseData = snapshot.val() || {};

        // 获取本地加载的图片库（由 init.js 的 loadStageImages 加载）
        const localLibrary = BlockingApp.data.stageImages?.library || {};

        // 合并：本地数据为基础，Firebase 数据补充
        const mergedLibrary = { ...localLibrary };

        // Firebase 中的额外数据也加入（用户之前上传的）
        Object.keys(firebaseData).forEach(key => {
            if (!mergedLibrary[key]) {
                mergedLibrary[key] = firebaseData[key];
            }
        });

        // 检查是否需要同步本地图片到 Firebase
        const localKeys = Object.keys(localLibrary);
        const firebaseKeys = Object.keys(firebaseData);
        const newKeys = localKeys.filter(k => !firebaseKeys.includes(k));

        if (newKeys.length > 0) {
            log(`  发现 ${newKeys.length} 张新图片，同步到 Firebase...`);

            const syncData = {};
            newKeys.forEach(key => {
                syncData[key] = {
                    name: localLibrary[key].name,
                    path: localLibrary[key].path
                };
            });

            await stageLibraryRef.update(syncData);
            log(`  ✓ 已同步 ${newKeys.length} 张图片元数据到 Firebase`);
        }

        // 更新内存中的图片库
        BlockingApp.data.stageImages.library = mergedLibrary;

        log('  图片库加载完成，共', Object.keys(mergedLibrary).length, '张');
    } catch (error) {
        logError('加载图片库失败:', error);
    }
}

// 保留兼容入口：当前版本不再依赖 GitHub 同步
export async function syncAllImagesToGitHub() {
    showStatus('当前版本无需配置 GitHub Token，图片已直接保存到 Firebase', 'info');
    return true;
}

// 加载场次配置
export async function loadSceneStageMap() {
    try {
        const snapshot = await sceneStageMapRef.once('value');
        sceneStageMap = snapshot.val() || {};
        log('  场次舞台图配置加载完成');
    } catch (error) {
        logError('加载场次配置失败:', error);
    }
}

// 获取某场次应该使用的舞台图
export function getStageImageForScene(sceneId) {
    const library = BlockingApp.data.stageImages.library || {};

    // 1. 检查是否有单独配置
    const customKey = sceneStageMap[sceneId];
    if (customKey && library[customKey]) {
        return library[customKey].base64;
    }

    // 2. 否则使用该幕的默认图
    const actNumber = getActFromSceneId(sceneId);
    return BlockingApp.data.stageImages[actNumber] || null;
}

// 上传图片到图片库
export async function uploadToLibrary(files, names = []) {
    if (!BlockingApp.data.stageImages.library) {
        BlockingApp.data.stageImages.library = {};
    }

    const results = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const customName = names[i] || file.name.replace(/\.[^.]+$/, '');

        try {
            showStatus(`正在上传 ${customName}...`, 'info');

            // 转换为 Base64
            const base64Content = await fileToBase64(file);

            // 生成唯一 key
            const imageKey = generateImageKey(customName);
            const path = `stage-layouts/library/${imageKey}.png`;
            // 直接保存到 Firebase（无需 GitHub Token）
            const imageData = {
                name: customName,
                base64: base64Content,
                path: path,
                uploadedAt: Date.now()
            };

            await stageLibraryRef.child(imageKey).set(imageData);

            // 更新本地缓存
            BlockingApp.data.stageImages.library[imageKey] = imageData;

            results.push({ success: true, name: customName, key: imageKey });
        } catch (error) {
            logError(`上传 ${customName} 失败:`, error);
            results.push({ success: false, name: customName, error: error.message });
        }
    }

    // 刷新界面
    renderLibraryTab();

    const successCount = results.filter(r => r.success).length;
    if (successCount === files.length) {
        showStatus(`成功上传 ${successCount} 张图片`, 'success');
    } else {
        showStatus(`上传完成: ${successCount}/${files.length} 成功`, 'warning');
    }

    return results;
}

// 从图片库删除
export async function deleteFromLibrary(imageKey) {
    const library = BlockingApp.data.stageImages.library || {};
    const imageData = library[imageKey];

    if (!imageData) {
        showStatus('图片不存在', 'error');
        return false;
    }

    // 检查是否有场次正在使用
    const usedBy = Object.entries(sceneStageMap)
        .filter(([_, key]) => key === imageKey)
        .map(([sceneId]) => sceneId);

    if (usedBy.length > 0) {
        showStatus(`该图片正被 ${usedBy.join(', ')} 使用，请先解除关联`, 'error');
        return false;
    }

    if (!confirm(`确定删除图片「${imageData.name}」？`)) {
        return false;
    }

    try {
        showStatus('正在删除...', 'info');

        // 从 Firebase 删除
        await stageLibraryRef.child(imageKey).remove();

        // 更新本地缓存
        delete BlockingApp.data.stageImages.library[imageKey];

        // 刷新界面
        renderLibraryTab();

        showStatus('图片已删除', 'success');
        return true;
    } catch (error) {
        logError('删除失败:', error);
        showStatus('删除失败: ' + error.message, 'error');
        return false;
    }
}

// 保存场次配置
export async function saveSceneStageMap(newConfig) {
    try {
        await sceneStageMapRef.set(newConfig);
        sceneStageMap = newConfig;
        showStatus('场次配置已保存', 'success');

        // 刷新当前场景的舞台图
        if (window.currentScene && window.loadStageMap) {
            window.loadStageMap(window.currentScene.id);
        }

        return true;
    } catch (error) {
        logError('保存场次配置失败:', error);
        showStatus('保存失败', 'error');
        return false;
    }
}

// 渲染图片库 Tab
function renderLibraryTab() {
    const container = document.getElementById('stageImageTabContent');
    if (!container) return;

    const library = BlockingApp.data.stageImages.library || {};
    const defaultImages = BlockingApp.data.stageImages || {};

    // 构建图片列表（默认图 + 自定义图）
    let html = '<div class="stage-library-grid">';

    // 默认的 4 幕图片
    ['1', '2', '3', '4'].forEach(act => {
        const base64 = defaultImages[act];
        html += `
            <div class="stage-library-item default-image">
                <div class="stage-image-preview">
                    ${base64
                        ? `<img src="${base64}" alt="第${act}幕">`
                        : '<div class="no-image">暂无</div>'
                    }
                </div>
                <div class="stage-image-name">第${act}幕（默认）</div>
            </div>
        `;
    });

    // 自定义图片
    Object.entries(library).forEach(([key, data]) => {
        html += `
            <div class="stage-library-item" data-key="${key}">
                <div class="stage-image-preview">
                    <img src="${data.base64}" alt="${data.name}">
                </div>
                <div class="stage-image-name">${data.name}</div>
                <button class="delete-image-btn" onclick="deleteStageImage('${key}')" title="删除">x</button>
            </div>
        `;
    });

    // 上传按钮
    html += `
        <div class="stage-library-item upload-item">
            <input type="file" id="libraryUploadInput" accept="image/*" multiple
                   onchange="handleLibraryUpload(this)" style="display: none;">
            <div class="upload-placeholder" onclick="document.getElementById('libraryUploadInput').click()">
                <div class="upload-icon">+</div>
                <div class="upload-text">上传图片</div>
                <div class="upload-hint">支持多选</div>
            </div>
        </div>
    `;

    html += '</div>';

    container.innerHTML = html;
}

// 渲染场次配置 Tab
function renderConfigTab() {
    const container = document.getElementById('stageImageTabContent');
    if (!container) return;

    const scenes = BlockingApp.data.scenes || [];
    const library = BlockingApp.data.stageImages.library || {};
    const defaultImages = BlockingApp.data.stageImages || {};

    let html = '<div class="scene-config-list">';

    scenes.forEach(scene => {
        const currentValue = sceneStageMap[scene.id] || '';
        const actNumber = getActFromSceneId(scene.id);

        html += `
            <div class="scene-config-item">
                <div class="scene-config-label">
                    <span class="scene-id">${scene.id}</span>
                    <span class="scene-name">${scene.name}</span>
                </div>
                <select class="scene-stage-select" data-scene="${scene.id}">
                    <option value="" ${!currentValue ? 'selected' : ''}>第${actNumber}幕（默认）</option>
        `;

        // 添加图片库选项
        Object.entries(library).forEach(([key, data]) => {
            html += `<option value="${key}" ${currentValue === key ? 'selected' : ''}>${data.name}</option>`;
        });

        html += `
                </select>
            </div>
        `;
    });

    html += '</div>';
    html += `
        <div class="config-actions">
            <button class="save-config-btn" onclick="saveStageConfig()">保存配置</button>
        </div>
    `;

    container.innerHTML = html;
}

// 切换 Tab
function switchTab(tab) {
    currentTab = tab;

    // 更新 Tab 按钮状态
    document.querySelectorAll('.stage-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // 渲染对应内容
    if (tab === 'library') {
        renderLibraryTab();
    } else {
        renderConfigTab();
    }
}

// 显示舞台图管理模态框
export function showStageImageManager() {
    const modal = document.getElementById('stageImageModal');
    if (!modal) return;

    const content = modal.querySelector('.modal-content');

    content.innerHTML = `
        <div class="modal-header">舞台图管理</div>
        <div class="stage-tabs">
            <button class="stage-tab-btn ${currentTab === 'library' ? 'active' : ''}"
                    data-tab="library" onclick="switchStageTab('library')">图片库</button>
            <button class="stage-tab-btn ${currentTab === 'config' ? 'active' : ''}"
                    data-tab="config" onclick="switchStageTab('config')">场次配置</button>
        </div>
        <div class="stage-tab-content" id="stageImageTabContent">
            <!-- 动态渲染 -->
        </div>
        <div class="modal-buttons">
            <button class="cancel" onclick="closeStageImageManager()">关闭</button>
        </div>
    `;

    // 渲染当前 Tab
    if (currentTab === 'library') {
        renderLibraryTab();
    } else {
        renderConfigTab();
    }

    modal.classList.add('active');
}

// 处理图片库上传
async function handleLibraryUpload(input) {
    const files = Array.from(input.files);
    if (files.length === 0) return;

    // 如果只有一张图，直接上传
    if (files.length === 1) {
        const name = prompt('请输入图片名称：', files[0].name.replace(/\.[^.]+$/, ''));
        if (name === null) return;
        await uploadToLibrary(files, [name]);
    } else {
        // 多张图片，使用文件名
        await uploadToLibrary(files);
    }

    // 清空 input
    input.value = '';
}

// 保存场次配置
function saveStageConfig() {
    const selects = document.querySelectorAll('.scene-stage-select');
    const newConfig = {};

    selects.forEach(select => {
        const sceneId = select.dataset.scene;
        const value = select.value;
        if (value) {
            newConfig[sceneId] = value;
        }
    });

    saveSceneStageMap(newConfig);
}

// 关闭舞台图管理模态框
export function closeStageImageManager() {
    const modal = document.getElementById('stageImageModal');
    if (modal) modal.classList.remove('active');
}

// 挂载到 window
window.showStageImageManager = showStageImageManager;
window.closeStageImageManager = closeStageImageManager;
window.handleLibraryUpload = handleLibraryUpload;
window.switchStageTab = switchTab;
window.deleteStageImage = deleteFromLibrary;
window.saveStageConfig = saveStageConfig;
window.getStageImageForScene = getStageImageForScene;
window.sceneStageMap = sceneStageMap;
window.syncAllImagesToGitHub = syncAllImagesToGitHub;
