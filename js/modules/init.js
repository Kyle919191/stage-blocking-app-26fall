// init.js - 初始化和数据加载模块
import {
    BlockingApp,
    blockingRef,
    scenesRef,
    dialogueEditsRef,
    lineOperationsRef,
    notesRef,
    scriptScenesRef,
    scriptCharactersRef,
    scriptLinesRef
} from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { withTimeout, showStatus, updateSaveStatus, getCurrentSceneId, safeAddEventListener, getSceneCharactersList } from '../utils/helpers.js';
import { features } from '../config.js';
import { loadStageLibrary, loadSceneStageMap, getStageImageForScene, getActFromSceneId } from './stageImages.js';

// 模块内部状态（数据存储）
let scenes = [];
let lines = [];
let blockingData = {};
let dialogueEdits = {};
let githubConfig = null;

function normalizeLineOperations(rawData) {
    const data = rawData || {};
    return {
        added: data.added || {},
        deleted: data.deleted || {}
    };
}

async function loadArrayFromFirebase(ref, label) {
    const firebasePromise = new Promise((resolve) => {
        ref.once('value', (snapshot) => {
            const data = snapshot.val();
            if (Array.isArray(data)) {
                log(`  🔥 使用 Firebase ${label}（${data.length} 条）`);
                resolve(data);
                return;
            }
            resolve(null);
        }, (error) => {
            logError(`  ❌ Firebase ${label} 读取失败:`, error);
            resolve(null);
        });
    });

    try {
        return await withTimeout(firebasePromise, 5000, `load ${label}`);
    } catch (error) {
        logError(`  ⚠️ Firebase ${label} 加载超时:`, error.message);
        return null;
    }
}

async function loadJsonArray(path, label) {
    log(`  📄 获取 ${path}...`);
    const response = await fetch(path);
    const data = await response.json();
    log(`  📋 本地 ${label} 读取到 ${data.length} 条`);
    return data;
}

// 使用 BlockingApp.state 作为统一UI状态源

// 导出获取器函数
export function getScenes() { return scenes; }
export function getLines() { return lines; }
export function getBlockingData() { return blockingData; }
export function getDialogueEdits() { return dialogueEdits; }
export function getCurrentView() { return BlockingApp.state.currentView; }
export function setCurrentView(view) { BlockingApp.state.currentView = view; }
export function getSelectedCharacter() { return BlockingApp.state.selectedCharacter; }
export function setSelectedCharacter(char) { BlockingApp.state.selectedCharacter = char; }
export function getGithubConfig() { return githubConfig; }
export function setGithubConfig(config) { githubConfig = config; }

// 初始化函数
export async function init() {
    try {
        log('🚀 开始初始化...');

        log('📝 加载GitHub配置...');
        loadGitHubConfig();

        if (githubConfig) {
            const repoEl = document.getElementById('githubRepo');
            const tokenEl = document.getElementById('githubToken');
            const branchEl = document.getElementById('githubBranch');

            if (repoEl) repoEl.value = githubConfig.repo || '';
            if (tokenEl) tokenEl.value = githubConfig.token || '';
            if (branchEl) branchEl.value = githubConfig.branch || 'main';
        }

        log('📦 开始加载核心数据...');
        showStatus('正在加载数据...', 'info');

        await Promise.all([
            loadScenes().then(() => log('✅ Scenes加载完成')),
            loadCharacters().then(() => log('✅ Characters加载完成')),
            loadLines().then(() => log('✅ Lines加载完成')),
            loadBlockingData().then(() => log('✅ Blocking加载完成')),
            loadLineOperations().then(() => log('✅ LineOperations加载完成')),
            loadNotes().then(() => log('✅ Notes加载完成')),
            loadStageImages().then(() => log('✅ StageImages加载完成')),
            loadStageLibrary().then(() => log('✅ StageLibrary加载完成')),
            loadSceneStageMap().then(() => log('✅ SceneStageMap加载完成')),
            window.initCommonActions ? window.initCommonActions().then(() => log('✅ CommonActions加载完成')) : Promise.resolve()
        ]);

        // 初始化撤销历史
        if (window.initHistory) {
            window.initHistory();
            log('✅ 撤销历史初始化完成');
        }

        log('🔧 设置场景选择器...');
        setupSceneSelector();

        log('🎯 设置事件监听器...');
        setupEventListeners();

        if (scenes.length > 0) {
            log('🎬 选择第一个场景:', scenes[0].id);
            selectScene(scenes[0].id);
        } else {
            logError('⚠️ 没有找到任何场景！');
        }

        showStatus(`数据加载完成（数据集: ${BlockingApp.data.datasetId}）`, 'success');
        log('✨ 初始化完成！');

        setTimeout(() => {
            log('📚 加载版本历史和引导...');
            if (window.loadVersions) window.loadVersions();
            checkOnboarding();
        }, 100);

    } catch (error) {
        logError('❌ 初始化失败:', error);
        logError('错误堆栈:', error.stack);
        showStatus('加载失败: ' + error.message, 'error');
    }
}

// 数据加载函数
export async function loadScenes() {
    const firebaseScenes = await loadArrayFromFirebase(scriptScenesRef, 'scriptData.scenes');
    scenes = firebaseScenes || await loadJsonArray('data/scenes.json', 'scenes');
    BlockingApp.data.scenes = scenes;
    log(`  📋 读取到 ${scenes.length} 个场景`);

    log('  🔥 从Firebase加载演员配置...');
    const firebasePromise = new Promise((resolve) => {
        scenesRef.once('value', (snapshot) => {
            const firebaseScenes = snapshot.val();
            if (firebaseScenes) {
                scenes.forEach(scene => {
                    if (firebaseScenes[scene.id]?.characters) {
                        scene.characters = firebaseScenes[scene.id].characters;
                    }
                });
                log('  ✓ Firebase演员配置加载完成');
            } else {
                log('  ℹ️ Firebase中没有演员配置数据');
            }
            resolve();
        }, (error) => {
            logError('  ❌ Firebase读取失败:', error);
            resolve();
        });
    });

    try {
        await withTimeout(firebasePromise, 5000, 'loadScenes Firebase');
    } catch (error) {
        logError('  ⚠️ Firebase加载超时，继续使用本地数据:', error.message);
    }
}

export async function loadCharacters() {
    const firebaseCharacters = await loadArrayFromFirebase(scriptCharactersRef, 'scriptData.characters');
    window.characters = firebaseCharacters || await loadJsonArray('data/characters.json', 'characters');
    BlockingApp.data.characters = window.characters;
    log(`  👥 读取到 ${window.characters.length} 个角色`);
}

export async function loadLines() {
    const firebaseLines = await loadArrayFromFirebase(scriptLinesRef, 'scriptData.lines');
    lines = firebaseLines || await loadJsonArray('data/lines.json', 'lines');
    BlockingApp.data.lines = lines;
    log(`  💬 读取到 ${lines.length} 条台词`);

    const sceneIndexMap = {};
    lines.forEach(line => {
        if (!sceneIndexMap[line.sceneId]) {
            sceneIndexMap[line.sceneId] = 0;
        }
        line.originalIndex = sceneIndexMap[line.sceneId];
        sceneIndexMap[line.sceneId]++;
    });

    await loadDialogueEdits();
}

async function loadDialogueEdits() {
    log('  🔥 从Firebase加载台词编辑...');
    const firebasePromise = new Promise((resolve) => {
        dialogueEditsRef.once('value', (snapshot) => {
            dialogueEdits = snapshot.val() || {};
            window.dialogueEdits = dialogueEdits;
            BlockingApp.data.dialogueEdits = dialogueEdits;
            log(`  ✓ 加载到 ${Object.keys(dialogueEdits).length} 条台词编辑`);

            const dialogueListener = dialogueEditsRef.on('value', (snapshot) => {
                if (BlockingApp.state.isLoadingFromFirebase) return;
                dialogueEdits = snapshot.val() || {};
                window.dialogueEdits = dialogueEdits;

                if (BlockingApp.state.currentView === 'lines' && window.currentScene) {
                    if (window.displayLines) window.displayLines(window.currentScene.id);
                }
            });

            BlockingApp.firebase.listeners.push({
                ref: dialogueEditsRef,
                listener: dialogueListener,
                off: () => dialogueEditsRef.off('value', dialogueListener)
            });

            resolve();
        }, (error) => {
            logError('  ❌ Firebase台词编辑读取失败:', error);
            resolve();
        });
    });

    try {
        await withTimeout(firebasePromise, 5000, 'loadDialogueEdits');
    } catch (error) {
        logError('  ⚠️ Firebase台词编辑加载超时:', error.message);
    }
}

export async function loadStageImages() {
    log('  🖼️ 加载stage-layouts图片...');

    // 默认幕图（act1-4）
    const acts = ['1', '2', '3', '4'];
    const stageImages = {};

    // 图片库列表（所有可用的stage-layouts）
    const libraryImages = [
        { key: 'default_blank', name: 'default-blank', path: 'stage-layouts/default-blank.png' },
        { key: 'identity_1p_v1', name: 'layout_1', path: 'stage-layouts/layout_1.png' },
        { key: 'identity_1p_v2', name: 'layout_2', path: 'stage-layouts/layout_2.png' },
        { key: 'identity_4p_v1', name: 'layout_3', path: 'stage-layouts/layout_3.png' },
        { key: 'identity_4p_v2', name: 'layout_4', path: 'stage-layouts/layout_4.png' },
        { key: 'xiaolin', name: 'layout_5', path: 'stage-layouts/layout_5.png' },
        { key: 'democracy', name: 'layout_6', path: 'stage-layouts/layout_6.png' },
        { key: 'airplane', name: 'layout_7', path: 'stage-layouts/layout_7.png' },
        { key: 'ktv', name: 'layout_8', path: 'stage-layouts/layout_8.png' },
        { key: 'deep_travel_v1', name: 'layout_9', path: 'stage-layouts/layout_9.png' },
        { key: 'deep_travel_v2', name: 'layout_10', path: 'stage-layouts/layout_10.png' },
        { key: 'sweet_sour_bitter_spicy', name: 'layout_11', path: 'stage-layouts/layout_11.png' }
    ];

    // 加载默认幕图
    for (const act of acts) {
        try {
            let response = await fetch(`stage-layouts/act${act}/stage.png`);
            if (!response.ok) {
                // 如果没有专门的幕图，使用默认空白图
                response = await fetch('stage-layouts/default-blank.png');
            }

            if (response.ok) {
                const blob = await response.blob();
                const base64 = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                stageImages[act] = base64;
                log(`    ✓ 第${act}幕舞台图加载成功`);
            }
        } catch (error) {
            logError(`    ✗ 第${act}幕舞台图加载失败:`, error);
        }
    }

    // 初始化图片库
    stageImages.library = {};

    // 加载图片库中的所有图片
    for (const img of libraryImages) {
        try {
            const response = await fetch(img.path);
            if (response.ok) {
                const blob = await response.blob();
                const base64 = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                stageImages.library[img.key] = {
                    name: img.name,
                    base64: base64,
                    path: img.path
                };
                log(`    ✓ 图片库: ${img.name} 加载成功`);
            }
        } catch (error) {
            logError(`    ✗ 图片库: ${img.name} 加载失败:`, error);
        }
    }

    BlockingApp.data.stageImages = stageImages;
    log(`  🖼️ stage-layouts加载完成，默认图 ${acts.length} 张，图片库 ${Object.keys(stageImages.library).length} 张`);
}

// 数据迁移：将"台下"(onStage: false)的角色改为未设定初始位置
function migrateOffstageCharacters(data) {
    let migratedCount = 0;

    Object.keys(data).forEach(sceneId => {
        const sceneData = data[sceneId];
        if (!sceneData) return;

        Object.keys(sceneData).forEach(charName => {
            const charData = sceneData[charName];
            if (charData?.initial && charData.initial.onStage === false) {
                // 删除"台下"的初始位置
                delete charData.initial;
                migratedCount++;
                log(`  🔄 迁移: ${sceneId}/${charName} 的"台下"初始位置已移除`);
            }
        });
    });

    if (migratedCount > 0) {
        log(`  ✅ 数据迁移完成，共处理 ${migratedCount} 个"台下"角色`);
        // 保存迁移后的数据到Firebase
        blockingRef.set(data);
    }
}

export async function loadBlockingData() {
    log('  🔥 从Firebase加载走位数据...');
    const firebasePromise = new Promise((resolve) => {
        BlockingApp.state.isLoadingFromFirebase = true;
        blockingRef.once('value', (snapshot) => {
            const data = snapshot.val();
            blockingData = data || {};
            window.blockingData = blockingData;
            BlockingApp.data.blockingData = blockingData;
            BlockingApp.state.isLoadingFromFirebase = false;
            log(`  ✓ 走位数据加载完成，共 ${Object.keys(blockingData).length} 个场景`);

            // 数据迁移：将"台下"(onStage: false)的角色改为未设定初始位置
            migrateOffstageCharacters(blockingData);

            setupFirebaseListener();
            resolve();
        }, (error) => {
            logError('  ❌ Firebase走位数据读取失败:', error);
            BlockingApp.state.isLoadingFromFirebase = false;
            resolve();
        });
    });

    try {
        await withTimeout(firebasePromise, 5000, 'loadBlockingData');
    } catch (error) {
        logError('  ⚠️ Firebase走位数据加载超时:', error.message);
        BlockingApp.state.isLoadingFromFirebase = false;
    }
}

function setupFirebaseListener() {
    const blockingListener = blockingRef.on('value', (snapshot) => {
        if (BlockingApp.state.isLoadingFromFirebase) return;

        const data = snapshot.val();
        if (data) {
            BlockingApp.state.isLoadingFromFirebase = true;
            blockingData = data;
            window.blockingData = blockingData;

            const sceneId = getCurrentSceneId();

            if (BlockingApp.state.currentView === 'lines') {
                if (sceneId && window.displayLines) {
                    window.displayLines(sceneId);
                }
                if (window.renderMarkers) {
                    window.renderMarkers();
                }
            } else if (BlockingApp.state.currentView === 'characters') {
                if (sceneId && window.displayCharacters) {
                    window.displayCharacters(sceneId);
                }
                if (BlockingApp.state.selectedCharacter && window.renderCharacterTrajectory) {
                    window.renderCharacterTrajectory();
                }
            }

            updateSaveStatus('synced');
            BlockingApp.state.isLoadingFromFirebase = false;
        }
    });

    BlockingApp.firebase.listeners.push({
        ref: blockingRef,
        listener: blockingListener,
        off: () => blockingRef.off('value', blockingListener)
    });
}

export async function loadLineOperations() {
    log('  🔥 从Firebase加载行操作...');
    const firebasePromise = new Promise((resolve) => {
        lineOperationsRef.once('value', (snapshot) => {
            const data = normalizeLineOperations(snapshot.val());
            window.lineOperations = data;
            BlockingApp.data.lineOperations = data;
            log(`  ✓ 行操作加载完成`);

            const lineOpListener = lineOperationsRef.on('value', (snapshot) => {
                if (BlockingApp.state.isLoadingFromFirebase) return;
                const data = normalizeLineOperations(snapshot.val());
                window.lineOperations = data;
                BlockingApp.data.lineOperations = data;

                if (BlockingApp.state.currentView === 'lines' && window.currentScene) {
                    if (window.displayLines) window.displayLines(window.currentScene.id);
                }
            });

            BlockingApp.firebase.listeners.push({
                ref: lineOperationsRef,
                listener: lineOpListener,
                off: () => lineOperationsRef.off('value', lineOpListener)
            });

            resolve();
        }, (error) => {
            logError('  ❌ Firebase行操作读取失败:', error);
            resolve();
        });
    });

    try {
        await withTimeout(firebasePromise, 5000, 'loadLineOperations');
    } catch (error) {
        logError('  ⚠️ Firebase行操作加载超时:', error.message);
    }
}

export async function loadNotes() {
    log('  🔥 从Firebase加载备注数据...');
    const firebasePromise = new Promise((resolve) => {
        notesRef.once('value', (snapshot) => {
            const data = snapshot.val() || {};
            window.notes = data;
            BlockingApp.data.notes = data;
            log(`  ✓ 备注加载完成，共 ${Object.keys(data).length} 个场景`);

            const notesListener = notesRef.on('value', (snapshot) => {
                if (BlockingApp.state.isLoadingFromFirebase) return;
                const data = snapshot.val() || {};
                window.notes = data;

                if (BlockingApp.state.currentView === 'lines' && window.currentScene) {
                    if (window.displayLines) window.displayLines(window.currentScene.id);
                }
            });

            BlockingApp.firebase.listeners.push({
                ref: notesRef,
                listener: notesListener,
                off: () => notesRef.off('value', notesListener)
            });

            resolve();
        }, (error) => {
            logError('  ❌ Firebase备注读取失败:', error);
            resolve();
        });
    });

    try {
        await withTimeout(firebasePromise, 5000, 'loadNotes');
    } catch (error) {
        logError('  ⚠️ Firebase备注加载超时:', error.message);
    }
}

function loadGitHubConfig() {
    const saved = localStorage.getItem('githubConfig');
    if (saved) {
        githubConfig = JSON.parse(saved);
    }
}

// 版本更新提示检查
const CURRENT_VERSION = '4.6';

export function checkOnboarding() {
    const lastSeenVersion = localStorage.getItem('lastSeenVersion');

    // 如果用户没看过这个版本的更新提示，就显示
    if (lastSeenVersion !== CURRENT_VERSION) {
        document.getElementById('onboardingModal').classList.add('active');
    }
}

export function closeOnboarding() {
    document.getElementById('onboardingModal').classList.remove('active');
    // 记录用户已看过当前版本的更新提示
    localStorage.setItem('lastSeenVersion', CURRENT_VERSION);
}

export function setupSceneSelector() {
    const select = document.getElementById('sceneSelect');
    select.innerHTML = scenes.map(scene =>
        `<option value="${scene.id}">${scene.id} ${scene.name}${scene.subtitle ? ' - ' + scene.subtitle : ''}</option>`
    ).join('');
}

export function setupEventListeners() {
    // 必需功能 - 场景选择
    safeAddEventListener('sceneSelect', 'change', (e) => {
        selectScene(e.target.value);
    });

    // 可选功能 - 搜索
    if (features.search) {
        safeAddEventListener('searchInput', 'input', (e) => {
            if (BlockingApp.state.currentView === 'lines') {
                if (window.filterLines) window.filterLines(e.target.value);
            } else {
                if (window.filterCharacters) window.filterCharacters(e.target.value);
            }
        });
    }
}

export function selectScene(sceneId) {
    log('selectScene called with:', sceneId, typeof sceneId);

    if (!sceneId || typeof sceneId !== 'string') {
        logError('无效的sceneId:', sceneId);
        return;
    }

    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) {
        logError('找不到场景:', sceneId);
        return;
    }

    log('设置currentScene为:', scene);
    window.currentScene = scene;

    if (!blockingData[sceneId]) {
        blockingData[sceneId] = {};
    }

    // 重置所有选中状态
    BlockingApp.state.selectedCharacter = null;
    BlockingApp.state.selectedLine = null;
    BlockingApp.state.selectedCharIndex = null;

    const movementsContainer = document.getElementById('movementsListContainer');
    if (movementsContainer) {
        movementsContainer.innerHTML = '';
    }

    loadStageMap(scene.stageMap);

    if (BlockingApp.state.currentView === 'lines') {
        if (window.displayLines) window.displayLines(sceneId);
    } else if (BlockingApp.state.currentView === 'characters') {
        if (window.displayCharacters) window.displayCharacters(sceneId);
    } else if (BlockingApp.state.currentView === 'blocking') {
        if (window.displayBlockingTimeline) window.displayBlockingTimeline(sceneId);
    }

    // 更新状态栏
    if (window.updateSceneStats) window.updateSceneStats();
}

export function loadStageMap(sceneIdOrMapFile) {
    const wrapper = document.getElementById('stageWrapper');

    // 获取当前场景ID
    let sceneId = window.currentScene?.id;

    // 兼容旧调用方式：如果传入的是 sceneId 格式（如 "1-1"）
    if (sceneIdOrMapFile && sceneIdOrMapFile.match(/^\d+-\d+$/)) {
        sceneId = sceneIdOrMapFile;
    }

    // 优先使用场次自定义配置的图片
    let imageSrc = null;
    if (sceneId) {
        imageSrc = getStageImageForScene(sceneId);
    }

    // 如果没有自定义配置，使用默认幕图
    if (!imageSrc) {
        let actNumber;
        if (sceneId) {
            actNumber = getActFromSceneId(sceneId);
        } else if (sceneIdOrMapFile) {
            // 兼容旧格式
            if (sceneIdOrMapFile.includes('/')) {
                actNumber = sceneIdOrMapFile.match(/act(\d+)/)?.[1] || '1';
            } else if (sceneIdOrMapFile.match(/^\d+\.png$/)) {
                actNumber = sceneIdOrMapFile.replace('.png', '');
            } else {
                actNumber = sceneIdOrMapFile;
            }
        } else {
            actNumber = '1';
        }
        imageSrc = BlockingApp.data.stageImages?.[actNumber] || `stage-layouts/act${actNumber}/stage.png`;
    }

    wrapper.innerHTML = `
        <img src="${imageSrc}" class="stage-image" id="stageImage" alt="stage-layouts">
        <svg class="stage-overlay" id="stageOverlay"></svg>
    `;

    const img = document.getElementById('stageImage');
    img.onload = () => {
        const svg = document.getElementById('stageOverlay');
        svg.setAttribute('width', img.clientWidth);
        svg.setAttribute('height', img.clientHeight);
        if (window.renderStageView) window.renderStageView();
    };

    const svg = document.getElementById('stageOverlay');
    svg.addEventListener('click', (e) => {
        if (window.handleStageClick) window.handleStageClick(e);
    });

    // 弧线控制点 + 走位点拖拽 + 边界框拖拽事件
    svg.addEventListener('mousemove', (e) => {
        if (window.handleControlPointDrag) window.handleControlPointDrag(e, svg);
        if (window.handleMarkerDrag) window.handleMarkerDrag(e, svg);
        if (window.handleBoundingBoxDrag) window.handleBoundingBoxDrag(e, svg);
    });
    svg.addEventListener('mouseup', () => {
        if (window.endControlPointDrag) window.endControlPointDrag();
        if (window.endMarkerDrag) window.endMarkerDrag();
        if (window.endBoundingBoxDrag) window.endBoundingBoxDrag();
    });
    svg.addEventListener('mouseleave', () => {
        if (window.endControlPointDrag) window.endControlPointDrag();
        if (window.endMarkerDrag) window.endMarkerDrag();
        if (window.endBoundingBoxDrag) window.endBoundingBoxDrag();
    });
}

// ========== 缩放功能 ==========
let currentZoom = 1;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

export function zoomStage(delta) {
    currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + delta));
    applyZoom();
}

export function resetZoom() {
    currentZoom = 1;
    applyZoom();
}

function applyZoom() {
    const wrapper = document.getElementById('stageWrapper');
    if (wrapper) {
        wrapper.style.transform = `scale(${currentZoom})`;
    }
    const zoomValue = document.getElementById('zoomValue');
    if (zoomValue) {
        zoomValue.textContent = Math.round(currentZoom * 100) + '%';
    }
}

// 挂载到 window
window.init = init;
window.closeOnboarding = closeOnboarding;
window.zoomStage = zoomStage;
window.resetZoom = resetZoom;
