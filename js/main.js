// main.js - 应用入口
// 电子走位本 v4.5

import { VERSION } from './config.js';
import { log, logError } from './utils/logger.js';
import { BlockingApp } from './services/firebase.js';

// 导入所有模块（它们会自动挂载函数到 window）
import './modules/init.js';
import './modules/lines.js';
import './modules/views.js';
import './modules/blocking.js';
import './modules/notes.js';
import './modules/commonActions.js';
import './modules/versions.js';
import './modules/github.js';
import './modules/export.js';
import './modules/stageImages.js';
import './modules/history.js';

// 初始化全局变量
window.blockingData = {};
window.dialogueEdits = {};
window.lineOperations = { added: {}, deleted: {} };
window.notes = {};
window.commonActions = [];
window.characters = [];
window.currentScene = null;
window.BlockingApp = BlockingApp;

// 添加当前输入内容到常用动作
window.addCurrentActionToCommon = function(inputId) {
    const input = document.getElementById(inputId);
    if (input && input.value.trim()) {
        window.addCommonAction(input.value.trim());
    }
};

// 应用启动
document.addEventListener('DOMContentLoaded', async () => {
    log(`🎭 电子走位本 ${VERSION} 启动中...`);

    try {
        // 调用初始化函数
        if (window.init) {
            await window.init();
            log('✅ 应用初始化完成');
        } else {
            throw new Error('init 函数未找到');
        }
    } catch (error) {
        logError('❌ 应用初始化失败:', error);
        alert('应用初始化失败，请刷新页面重试。错误: ' + error.message);
    }
});

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
    if (BlockingApp.cleanup) {
        BlockingApp.cleanup();
    }
});

// 验证所有必需函数是否已挂载
const requiredFunctions = [
    // 视图相关
    'switchView', 'switchMode', 'updateSceneStats',
    'displayLines', 'displayCharacters', 'displayBlockingTimeline', 'selectBlockingStep',
    'filterLines', 'filterCharacters',
    'selectCharacter', 'selectCharacterForView',

    // 台词编辑
    'startEditLine', 'saveLineEdit', 'cancelEdit', 'restoreOriginal',
    'deleteLine', 'showAddLineForm', 'addNewLine', 'cancelAddLine',
    'toggleCharacterSelect',

    // 走位相关
    'startSetInitial', 'renderStageView',
    'showCharacterModal', 'selectCharacterAction', 'closeCharacterModal',
    'deleteMovement',

    // 自由走位
    'startAddFreeMovement', 'deleteFreeMovement',
    'showLineAssociationModal', 'closeLineAssociationModal',
    'selectLineForAssociation', 'confirmLineAssociation',
    'selectCharacterPosition', 'closeCharacterPositionModal',
    'unlinkMovement',

    // 备注功能
    'startAddNote', 'saveNote', 'deleteNote', 'closeNoteInputModal',

    // 版本管理
    'loadVersions', 'toggleVersionHistory',
    'openSaveVersionModal', 'closeSaveVersionModal', 'saveVersion',
    'restoreVersion', 'deleteVersion',

    // 演员配置
    'openConfigActorsModal', 'closeConfigActorsModal', 'saveActorsConfig',

    // GitHub Actions 触发
    'triggerGitHubSync',

    // PDF导出
    'openExportPDFModal', 'closeExportPDFModal',
    'selectAllScenes', 'deselectAllScenes', 'generatePDF',

    // 初始化相关
    'closeOnboarding', 'init'
];

// 延迟检查（给模块加载时间）
setTimeout(() => {
    const missing = requiredFunctions.filter(fn => typeof window[fn] !== 'function');
    if (missing.length > 0) {
        console.warn('⚠️ 以下函数未挂载到 window:', missing);
    } else {
        log('✅ 所有必需函数已挂载');
    }
}, 100);
