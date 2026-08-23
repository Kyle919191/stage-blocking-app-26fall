// firebase.js - Firebase 操作封装
import { firebaseConfig } from '../config.js';
import { log, logError } from '../utils/logger.js';
import { getCurrentSceneId, validateFirebasePath } from '../utils/helpers.js';

// 初始化Firebase (firebase SDK通过script标签在HTML中加载)
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

function sanitizeDatasetId(rawDatasetId) {
    const fallback = 'default';
    if (!rawDatasetId || typeof rawDatasetId !== 'string') return fallback;
    const trimmed = rawDatasetId.trim();
    if (!trimmed) return fallback;
    const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!normalized) return fallback;
    return normalized.slice(0, 64);
}

function getDatasetIdFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        return sanitizeDatasetId(params.get('dataset'));
    } catch (error) {
        logError('读取 dataset 参数失败，使用默认值:', error);
        return 'default';
    }
}

export const currentDatasetId = getDatasetIdFromUrl();
const useLegacyTopLevel = currentDatasetId === 'default';
const datasetBasePath = useLegacyTopLevel ? null : `datasets/${currentDatasetId}`;

function refFor(nodeName) {
    if (useLegacyTopLevel) {
        return database.ref(nodeName);
    }
    return database.ref(`${datasetBasePath}/${nodeName}`);
}

// BlockingApp 命名空间 - 封装所有全局状态
export const BlockingApp = {
    // Firebase 引用
    firebase: {
        database: database,
        datasetId: currentDatasetId,
        datasetBasePath: datasetBasePath || '(legacy root)',
        blockingRef: refFor('blockingData'),
        versionsRef: refFor('versions'),
        scenesRef: refFor('scenes'),
        dialogueEditsRef: refFor('dialogueEdits'),
        lineOperationsRef: refFor('lineOperations'),
        notesRef: refFor('notes'),
        commonActionsRef: refFor('commonActions'),
        stageLibraryRef: refFor('stageLibrary'),
        sceneStageMapRef: refFor('sceneStageMap'),
        scriptScenesRef: refFor('scriptData/scenes'),
        scriptCharactersRef: refFor('scriptData/characters'),
        scriptLinesRef: refFor('scriptData/lines'),
        listeners: []
    },

    // 数据存储
    data: {
        datasetId: currentDatasetId,
        scenes: [],
        characters: [],
        lines: [],
        blockingData: {},
        versions: [],
        dialogueEdits: {},
        lineOperations: { added: {}, deleted: {} },
        notes: {},
        stageImages: {},
        commonActions: []
    },

    // 应用状态
    state: {
        currentScene: null,
        currentView: 'lines',
        currentMode: 'blocking',  // 'blocking' 或 'note'
        selectedLine: null,
        selectedCharIndex: null,
        selectedCharacter: null,
        selectedBlockingSnapshot: null,
        pendingMarker: null,
        settingInitial: false,
        addingFreeMovement: false,
        addingNote: false,
        githubConfig: null,
        currentlyEditingLine: null,
        autoSaveTimer: null,
        isLoadingFromFirebase: false
    },

    // 清理函数
    cleanup: {
        removeAllListeners: function() {
            BlockingApp.firebase.listeners.forEach(listener => {
                if (listener && listener.off) {
                    listener.off();
                }
            });
            BlockingApp.firebase.listeners = [];
        },
        clearTimers: function() {
            if (BlockingApp.state.autoSaveTimer) {
                clearTimeout(BlockingApp.state.autoSaveTimer);
                BlockingApp.state.autoSaveTimer = null;
            }
        }
    }
};

// FirebaseHelper - 数据操作封装层
export const FirebaseHelper = {
    // 台词操作模块
    lines: {
        async add(lineData) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const lineId = `${sceneId}-new-${Date.now()}`;
            const path = `lineOperations/added/${sceneId}/${lineId}`;

            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            // 保存到本地
            if (!window.lineOperations) {
                window.lineOperations = { added: {}, deleted: {} };
            }
            if (!window.lineOperations.added[sceneId]) {
                window.lineOperations.added[sceneId] = {};
            }
            window.lineOperations.added[sceneId][lineId] = lineData;

            // 保存到Firebase
            await BlockingApp.firebase.lineOperationsRef
                .child(`added/${sceneId}/${lineId}`)
                .set(lineData);

            return lineId;
        },

        async delete(lineId) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const path = `lineOperations/deleted/${sceneId}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            // 更新本地数据
            if (!window.lineOperations.deleted) {
                window.lineOperations.deleted = {};
            }
            if (!window.lineOperations.deleted[sceneId]) {
                window.lineOperations.deleted[sceneId] = [];
            }
            window.lineOperations.deleted[sceneId].push(lineId);

            // 保存到Firebase
            await BlockingApp.firebase.lineOperationsRef
                .child(`deleted/${sceneId}`)
                .set(window.lineOperations.deleted[sceneId]);
        },

        async edit(lineId, newContent) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const path = `dialogueEdits/${lineId}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            await BlockingApp.firebase.dialogueEditsRef
                .child(lineId)
                .set(newContent);
        }
    },

    // 走位操作模块
    blocking: {
        async update(characterName, movementData) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const path = `blockingData/${sceneId}/${characterName}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            // 更新本地数据
            if (!window.blockingData[sceneId]) {
                window.blockingData[sceneId] = {};
            }
            window.blockingData[sceneId][characterName] = movementData;

            // 保存到Firebase
            await BlockingApp.firebase.blockingRef
                .child(`${sceneId}/${characterName}`)
                .set(movementData);
        },

        async deleteMovement(characterName, movementIndex) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const charData = window.blockingData[sceneId]?.[characterName];
            if (!charData || !charData.movements) {
                throw new Error('未找到角色走位数据');
            }

            charData.movements.splice(movementIndex, 1);
            await this.update(characterName, charData);
        }
    },

    // 场景操作模块
    scenes: {
        async updateCharacters(characters) {
            const sceneId = getCurrentSceneId();
            if (!sceneId) {
                throw new Error('未选择场景');
            }

            const path = `scenes/${sceneId}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            await BlockingApp.firebase.scenesRef
                .child(sceneId)
                .update({ characters });
        }
    },

    // 版本管理模块
    versions: {
        async save(versionData) {
            const path = `versions/${versionData.id}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            await BlockingApp.firebase.versionsRef
                .child(versionData.id)
                .set(versionData);
        },

        async restore(versionId) {
            const snapshot = await BlockingApp.firebase.versionsRef
                .child(versionId)
                .once('value');

            const versionData = snapshot.val();
            if (!versionData) {
                throw new Error('版本不存在');
            }

            // 恢复走位数据
            if (versionData.data) {
                await BlockingApp.firebase.blockingRef.set(versionData.data);
            }

            // 恢复台词编辑
            if (versionData.dialogueEdits) {
                await BlockingApp.firebase.dialogueEditsRef.set(versionData.dialogueEdits);
            }

            // 恢复行操作
            if (versionData.lineOperations) {
                await BlockingApp.firebase.lineOperationsRef.set(versionData.lineOperations);
            }

            return versionData;
        },

        async delete(versionId) {
            const path = `versions/${versionId}`;
            if (!validateFirebasePath(path)) {
                throw new Error('无效的数据路径');
            }

            await BlockingApp.firebase.versionsRef
                .child(versionId)
                .remove();
        }
    }
};

// 导出便捷引用
export const blockingRef = BlockingApp.firebase.blockingRef;
export const versionsRef = BlockingApp.firebase.versionsRef;
export const scenesRef = BlockingApp.firebase.scenesRef;
export const dialogueEditsRef = BlockingApp.firebase.dialogueEditsRef;
export const lineOperationsRef = BlockingApp.firebase.lineOperationsRef;
export const notesRef = BlockingApp.firebase.notesRef;
export const commonActionsRef = BlockingApp.firebase.commonActionsRef;
export const stageLibraryRef = BlockingApp.firebase.stageLibraryRef;
export const sceneStageMapRef = BlockingApp.firebase.sceneStageMapRef;
export const scriptScenesRef = BlockingApp.firebase.scriptScenesRef;
export const scriptCharactersRef = BlockingApp.firebase.scriptCharactersRef;
export const scriptLinesRef = BlockingApp.firebase.scriptLinesRef;
