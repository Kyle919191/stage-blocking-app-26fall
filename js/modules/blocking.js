// blocking.js - 走位交互模块
import { BlockingApp, blockingRef } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { showStatus, updateSaveStatus, sortMovements, getRelativeCoordinates, ensureCharacterData, getSceneCharactersList } from '../utils/helpers.js';

// 使用 BlockingApp.state 作为统一状态源
// 仅保留本模块专用的状态
let pendingMarker = null;
let autoSaveTimer = null;
let editingMovementIndex = null;
let selectedLineForAssociation = null;
let pendingLineIdForCharPosition = null;  // 保存要关联的台词ID

// 初始位置设置相关状态
let pendingInitialCharacter = null;

// 弧线走位相关状态
let draggingControlPoint = null;  // { charName, movementIndex, isFromInitial }
let selectedArrowForCurve = null;  // { charName, movementIndex }

// 走位点拖拽状态
let draggingMarker = null;  // { charName, isInitial, movementIndex }

// 多选状态
let selectedMarkers = [];  // { charName, isInitial, movementIndex, x, y }[]
let isMultiSelectMode = false;
let dragStartPositions = {};  // 保存拖拽开始时各点的位置

// 坐标调整模式（只有在此模式下才能选中/拖动/删除走位点）
let isCoordinateAdjustMode = false;

// 缩放状态（已弃用，改用边界框控制点）
let isScalingMode = false;
let scaleCenter = null;  // { x, y } 选中点的中心

// 边界框拖拽状态
let draggingHandle = null;  // 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null
let boundingBox = null;  // { minX, minY, maxX, maxY }
let initialBoundingBox = null;  // 拖拽开始时的边界框（不随拖拽变化）

// 导出状态获取器（从 BlockingApp.state 读取）
export function isSettingInitial() { return BlockingApp.state.settingInitial; }
export function isAddingFreeMovement() { return BlockingApp.state.addingFreeMovement; }
export function setAddingFreeMovement(val) { BlockingApp.state.addingFreeMovement = val; }
export function getSelectedCharacter() { return BlockingApp.state.selectedCharacter; }
export function setSelectedCharacter(char) { BlockingApp.state.selectedCharacter = char; }

// 开始设置初始位置 - 先选角色再选位置
export function startSetInitial() {
    // 先弹出模态框选择角色
    showInitialCharacterModal();
}

// 显示初始位置角色选择模态框
function showInitialCharacterModal() {
    const modal = document.getElementById('characterModal');
    const grid = document.getElementById('characterGrid');
    const header = document.getElementById('modalHeader');

    header.textContent = '设置初始位置 - 选择角色';

    // 获取场次角色（使用公共函数，自动处理合台词解析）
    const sceneCharacters = getSceneCharactersList(
        BlockingApp.data.scenes,
        BlockingApp.data.lines,
        window.currentScene.id
    );

    grid.innerHTML = sceneCharacters.map(charName => {
        const character = window.characters.find(c => c.name === charName);
        if (!character) return '';

        const charData = window.blockingData[window.currentScene.id]?.[charName];
        const hasInitial = charData?.initial;

        return `
            <div class="character-option ${hasInitial ? 'disabled' : ''}"
                 ${hasInitial ? 'style="pointer-events: none;"' : `onclick="selectInitialCharacter('${charName}')"`}>
                <span class="character-badge" style="background: ${character.color}">${character.name}</span>
                <span>${character.fullName}</span>
                ${hasInitial ? '<span class="already-set">✓ 已设置</span>' : ''}
            </div>
        `;
    }).join('');

    // 添加确认按钮的逻辑（修改模态框按钮）
    const modalButtons = modal.querySelector('.modal-buttons');
    modalButtons.innerHTML = `
        <button class="confirm" id="confirmInitialBtn" onclick="confirmInitialCharacter()" style="display: none;">确认</button>
        <button class="cancel" onclick="closeCharacterModal()">取消</button>
    `;

    modal.classList.add('active');
}

// 选择初始位置的角色
export function selectInitialCharacter(charName) {
    // 高亮选中的角色
    document.querySelectorAll('.character-option').forEach(el => el.classList.remove('selected'));
    event.target.closest('.character-option').classList.add('selected');

    pendingInitialCharacter = charName;

    // 显示确认按钮
    const confirmBtn = document.getElementById('confirmInitialBtn');
    if (confirmBtn) {
        confirmBtn.style.display = 'inline-block';
    }
}

// 确认角色选择，进入位置选择模式
export function confirmInitialCharacter() {
    if (!pendingInitialCharacter) {
        showStatus('请先选择一个角色', 'warning');
        return;
    }

    // 关闭模态框
    document.getElementById('characterModal').classList.remove('active');

    // 进入位置选择模式
    BlockingApp.state.settingInitial = true;
    showStatus(`为 ${pendingInitialCharacter} 设置初始位置：请在stage-layouts上点击`, 'info');
}

// 处理舞台点击
export function handleStageClick(e) {
    // 优先处理：设置初始位置、添加走位（已选择字符时）
    // 这些操作优先于走位点的点击处理
    if (BlockingApp.state.settingInitial) {
        handleInitialPosition(e);
        return;
    }

    if (BlockingApp.state.addingFreeMovement && BlockingApp.state.currentView === 'characters' && BlockingApp.state.selectedCharacter) {
        const svg = e.currentTarget;
        const coords = getRelativeCoordinates(e, svg);
        addFreeMovementToCharacter(coords.x, coords.y);
        BlockingApp.state.addingFreeMovement = false;
        return;
    }

    // 台词视图中已选择字符，优先添加走位
    if (BlockingApp.state.currentView === 'lines' && BlockingApp.state.selectedLine) {
        handleMovement(e);
        return;
    }

    // 如果点击的是走位点（circle）且在坐标调整模式，让走位点自己处理（删除/选择）
    if ((e.target.tagName === 'circle' || e.target.closest('circle')) && isCoordinateAdjustMode) {
        return;
    }

    // 台词视图但未选择字符
    if (BlockingApp.state.currentView === 'lines') {
        showStatus('请先选择台词中的一个字', 'warning');
    }
}

// 处理初始位置设置 - 直接使用已选择的角色
function handleInitialPosition(e) {
    if (!pendingInitialCharacter) {
        showStatus('请先选择角色', 'warning');
        BlockingApp.state.settingInitial = false;
        return;
    }

    const svg = e.currentTarget;
    const coords = getRelativeCoordinates(e, svg);

    // 直接设置初始位置
    if (!window.blockingData[window.currentScene.id]) {
        window.blockingData[window.currentScene.id] = {};
    }
    if (!window.blockingData[window.currentScene.id][pendingInitialCharacter]) {
        window.blockingData[window.currentScene.id][pendingInitialCharacter] = { movements: [] };
    }

    window.blockingData[window.currentScene.id][pendingInitialCharacter].initial = {
        x: coords.x,
        y: coords.y
    };

    showStatus(`已设置 ${pendingInitialCharacter} 的初始位置`, 'success');
    BlockingApp.state.settingInitial = false;
    pendingInitialCharacter = null;
    autoSave();
    renderStageView();

    if (BlockingApp.state.currentView === 'characters' && window.displayCharacters) {
        window.displayCharacters(window.currentScene.id);
    }
}

// 处理移动记录
function handleMovement(e) {
    const svg = e.currentTarget;
    const coords = getRelativeCoordinates(e, svg);
    pendingMarker = { x: coords.x, y: coords.y };
    showCharacterModal('选择移动的演员', false, false);
}

// 显示角色选择模态框
export function showCharacterModal(title, showStageToggle, showOnlyWithoutInitial) {
    const modal = document.getElementById('characterModal');
    const grid = document.getElementById('characterGrid');
    const header = document.getElementById('modalHeader');
    const stageToggle = document.getElementById('stageToggle');

    header.textContent = title;
    if (stageToggle) {
        stageToggle.style.display = showStageToggle ? 'flex' : 'none';
    }

    // 获取场次角色（使用公共函数，自动处理合台词解析）
    const sceneCharacters = getSceneCharactersList(
        BlockingApp.data.scenes,
        BlockingApp.data.lines,
        window.currentScene.id
    );

    grid.innerHTML = sceneCharacters.map(charName => {
        const character = window.characters.find(c => c.name === charName);
        if (!character) return '';

        const charData = window.blockingData[window.currentScene.id]?.[charName];
        const hasInitial = charData?.initial;
        const disabled = showOnlyWithoutInitial ? hasInitial : !hasInitial;

        return `
            <div class="character-option ${disabled ? 'disabled' : ''}"
                 ${disabled ? 'onclick="return false;" style="pointer-events: none;"' : `onclick="selectCharacterAction('${charName}')"`}>
                <span class="character-badge" style="background: ${character.color}">${character.name}</span>
                <span>${character.fullName}</span>
            </div>
        `;
    }).join('');

    modal.classList.add('active');
}

// 关闭角色模态框
export function closeCharacterModal() {
    document.getElementById('characterModal').classList.remove('active');
    pendingMarker = null;
    pendingInitialCharacter = null;
    BlockingApp.state.settingInitial = false;
}

// 选择角色动作
export function selectCharacterAction(characterName) {
    if (!pendingMarker) return;

    if (BlockingApp.state.settingInitial) {
        if (!window.blockingData[window.currentScene.id]) {
            window.blockingData[window.currentScene.id] = {};
        }
        if (!window.blockingData[window.currentScene.id][characterName]) {
            window.blockingData[window.currentScene.id][characterName] = { movements: [] };
        }

        window.blockingData[window.currentScene.id][characterName].initial = {
            x: pendingMarker.x,
            y: pendingMarker.y
        };

        showStatus(`已设置 ${characterName} 的初始位置`, 'success');
        BlockingApp.state.settingInitial = false;
        autoSave();
    } else {
        if (!window.blockingData[window.currentScene.id][characterName]) {
            showStatus(`${characterName} 还没有初始位置，请先设置初始位置`, 'warning');
            closeCharacterModal();
            return;
        }

        if (!window.blockingData[window.currentScene.id][characterName].movements) {
            window.blockingData[window.currentScene.id][characterName].movements = [];
        }

        window.blockingData[window.currentScene.id][characterName].movements.push({
            lineId: BlockingApp.state.selectedLine,
            charIndex: BlockingApp.state.selectedCharIndex,
            x: pendingMarker.x,
            y: pendingMarker.y,
            timestamp: Date.now(),
            type: "line"
        });

        showStatus(`已添加 ${characterName} 的移动`, 'success');
        autoSave();
    }

    closeCharacterModal();
    renderStageView();

    // 刷新当前视图
    if (BlockingApp.state.currentView === 'characters' && window.displayCharacters) {
        window.displayCharacters(window.currentScene.id);
    } else if (BlockingApp.state.currentView === 'lines' && window.displayLines) {
        window.displayLines(window.currentScene.id);
    }
}

// 渲染舞台视图
export function renderStageView() {
    const svg = document.getElementById('stageOverlay');
    if (!svg || !window.currentScene) return;

    svg.innerHTML = '';

    if (BlockingApp.state.currentView === 'lines') {
        if (BlockingApp.state.selectedLine) {
            renderLineSnapshot();
        } else {
            // 默认显示开场状态
            renderOpeningSnapshot();
        }
    } else if (BlockingApp.state.currentView === 'blocking') {
        if (BlockingApp.state.selectedBlockingSnapshot) {
            renderBlockingSnapshot(BlockingApp.state.selectedBlockingSnapshot);
        } else {
            renderOpeningSnapshot();
        }
    } else if (BlockingApp.state.currentView === 'characters' && BlockingApp.state.selectedCharacter) {
        renderCharacterTrajectory();
        updatePositionDisplay('角色视图', BlockingApp.state.selectedCharacter);
    }

    // 如果选中了多个点，绘制边界框
    if (selectedMarkers.length >= 2) {
        drawBoundingBox(svg);
    }
}

function renderBlockingSnapshot(snapshot) {
    const svg = document.getElementById('stageOverlay');
    if (!svg || !snapshot) return;

    updatePositionDisplay('走位视图', `Step ${snapshot.index + 1}`);

    Object.entries(snapshot.positions || {}).forEach(([charName, marker]) => {
        const character = window.characters.find(c => c.name === charName);
        if (!character || !marker) return;
        drawMarker(
            svg,
            marker.x,
            marker.y,
            character.color,
            charName,
            !!marker.isInitial,
            charName,
            true,
            marker.movementIndex ?? -1
        );
    });
}

// 渲染开场快照（所有角色的初始位置）
function renderOpeningSnapshot() {
    const svg = document.getElementById('stageOverlay');
    const sceneData = window.blockingData[window.currentScene.id] || {};

    updatePositionDisplay('开场');

    Object.keys(sceneData).forEach(charName => {
        const charData = sceneData[charName];
        if (!charData.initial) return;

        const character = window.characters.find(c => c.name === charName);
        if (!character) return;

        drawMarker(svg, charData.initial.x, charData.initial.y, character.color, charName, true, charName, true, -1);
    });
}

// 格式化台词内容用于显示（不超过25字）
function formatLineContent(content, charIndex) {
    const maxLen = 25;
    if (content.length <= maxLen) {
        // 短句子直接显示，高亮当前字
        return highlightChar(content, charIndex);
    }

    // 长句子：尝试从前一个句号开始
    const beforeIndex = content.substring(0, charIndex);
    const lastPeriod = Math.max(
        beforeIndex.lastIndexOf('。'),
        beforeIndex.lastIndexOf('！'),
        beforeIndex.lastIndexOf('？'),
        beforeIndex.lastIndexOf('，')
    );

    let start = 0;
    if (lastPeriod > 0 && charIndex - lastPeriod < maxLen) {
        start = lastPeriod + 1;
    } else if (charIndex > maxLen - 5) {
        // 从当前字往前取
        start = charIndex - 10;
    }

    let excerpt = content.substring(start, start + maxLen);
    if (start > 0) excerpt = '…' + excerpt;
    if (start + maxLen < content.length) excerpt = excerpt + '…';

    return highlightChar(excerpt, charIndex - start + (start > 0 ? 1 : 0));
}

// 高亮指定位置的字符
function highlightChar(text, index) {
    if (index < 0 || index >= text.length) return text;
    return text.substring(0, index) + '【' + text[index] + '】' + text.substring(index + 1);
}

// 根据 lineId 获取格式化的台词显示
function getFormattedLineDisplay(lineId, charIndex) {
    const line = BlockingApp.data.lines.find(l =>
        `${l.sceneId}-${l.originalIndex}` === lineId
    );
    if (!line) return `${lineId}[${charIndex}]`;

    const formattedContent = formatLineContent(line.content, charIndex);
    return `${line.character}：${formattedContent}`;
}

// 更新位置显示框
function updatePositionDisplay(type, detail = '') {
    const positionContent = document.getElementById('positionContent');
    if (!positionContent) return;

    if (type === '开场') {
        positionContent.textContent = '开场';
    } else if (type === '角色视图') {
        positionContent.textContent = `角色视图 - ${detail}`;
    } else {
        positionContent.textContent = detail;
    }
}

// 渲染台词快照（某个字符位置的角色分布）
function renderLineSnapshot() {
    const svg = document.getElementById('stageOverlay');
    const sceneData = window.blockingData[window.currentScene.id] || {};

    const selectedLineIndex = parseInt(BlockingApp.state.selectedLine.split('-').pop());

    // 更新位置显示框 - 显示台词内容
    const charIndex = BlockingApp.state.selectedCharIndex || 0;
    const displayText = getFormattedLineDisplay(BlockingApp.state.selectedLine, charIndex);
    updatePositionDisplay('台词', displayText);

    Object.keys(sceneData).forEach(charName => {
        const charData = sceneData[charName];
        // 如果既没有初始位置也没有走位，跳过
        if (!charData.initial && (!charData.movements || charData.movements.length === 0)) return;

        const character = window.characters.find(c => c.name === charName);
        if (!character) return;

        let position = charData.initial;  // 可能为 null
        let positionMovementIndex = -1;  // -1 表示初始位置

        if (charData.movements && charData.movements.length > 0) {
            const sortedMovements = [...charData.movements];
            sortMovements(sortedMovements);

            for (const movement of sortedMovements) {
                if (movement.lineId) {
                    const movementLineIndex = parseInt(movement.lineId.split('-').pop());
                    const movementCharIndex = movement.charIndex || 0;

                    if (movementLineIndex < selectedLineIndex ||
                        (movementLineIndex === selectedLineIndex && movementCharIndex <= BlockingApp.state.selectedCharIndex)) {
                        position = movement;
                        positionMovementIndex = charData.movements.indexOf(movement);
                    } else {
                        break;
                    }
                } else {
                    const nextLineMovement = sortedMovements.find((m, idx) =>
                        idx > sortedMovements.indexOf(movement) && m.lineId
                    );

                    if (!nextLineMovement) {
                        position = movement;
                        positionMovementIndex = charData.movements.indexOf(movement);
                    } else {
                        const nextLineIndex = parseInt(nextLineMovement.lineId.split('-').pop());
                        const nextCharIndex = nextLineMovement.charIndex || 0;

                        if (nextLineIndex > selectedLineIndex ||
                            (nextLineIndex === selectedLineIndex && nextCharIndex > BlockingApp.state.selectedCharIndex)) {
                            position = movement;
                            positionMovementIndex = charData.movements.indexOf(movement);
                        }
                    }
                }
            }
        }

        // 如果找不到有效位置（无初始位置且当前台词之前没有走位），跳过
        if (!position) return;

        const isInitialPos = (positionMovementIndex === -1);
        drawMarker(svg, position.x, position.y, character.color, charName, isInitialPos, charName, true, positionMovementIndex);
    });
}

// 渲染角色轨迹
export function renderCharacterTrajectory() {
    const svg = document.getElementById('stageOverlay');
    const charName = BlockingApp.state.selectedCharacter;
    const charData = window.blockingData[window.currentScene.id]?.[charName];

    if (!charData || (!charData.initial && (!charData.movements || charData.movements.length === 0))) {
        showStatus(`${charName} 还没有设置走位`, 'warning');
        svg.innerHTML = '';
        return;
    }

    const character = window.characters.find(c => c.name === charName);
    if (!character) return;

    const sortedMovements = charData.movements ? [...charData.movements] : [];
    sortMovements(sortedMovements);

    // 如果有初始位置，从初始位置开始；否则从第一个走位开始
    const hasInitial = !!charData.initial;

    // 绘制箭头（支持弧线）
    if (hasInitial && sortedMovements.length > 0) {
        // 从初始位置到第一个走位
        const from = charData.initial;
        const to = sortedMovements[0];
        const controlPoint = to.controlPointFromPrev || null;
        const arrowMeta = { charName, movementIndex: -1 };
        drawArrow(svg, from.x, from.y, to.x, to.y, character.color, controlPoint, arrowMeta);
    }

    // 走位之间的箭头
    for (let i = 0; i < sortedMovements.length - 1; i++) {
        const from = sortedMovements[i];
        const to = sortedMovements[i + 1];
        const controlPoint = to.controlPointFromPrev || null;
        const realIndex = charData.movements.indexOf(to);
        const arrowMeta = { charName, movementIndex: realIndex };
        drawArrow(svg, from.x, from.y, to.x, to.y, character.color, controlPoint, arrowMeta);
    }

    // 绘制点（传递 movementIndex 以支持拖拽）
    if (hasInitial) {
        // 绘制初始位置
        drawMarker(svg, charData.initial.x, charData.initial.y, character.color, '起点', true, charName, true, -1);
    }

    // 绘制走位点
    sortedMovements.forEach((point) => {
        const realIndex = charData.movements.indexOf(point);
        drawMarker(svg, point.x, point.y, character.color, charName, false, charName, true, realIndex);
    });

    // 如果没有初始位置但有走位，显示提示
    if (!hasInitial && sortedMovements.length > 0) {
        showStatus(`${charName} 还没有设置初始位置`, 'info');
    }
}

// 绘制标记（支持拖拽）
export function drawMarker(svg, x, y, color, label, isStart = false, charName = null, deletable = false, movementIndex = -1) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', `${x}%`);
    circle.setAttribute('cy', `${y}%`);
    circle.setAttribute('r', isStart ? '13' : '11');
    circle.setAttribute('fill', color);

    // 检查是否被选中（多选模式）
    const isSelected = isMarkerSelected(charName, isStart, movementIndex);
    if (isSelected) {
        circle.setAttribute('stroke', '#22c55e');  // 绿色边框表示选中
        circle.setAttribute('stroke-width', '4');
        circle.setAttribute('stroke-dasharray', '6,3');
    } else {
        circle.setAttribute('stroke', '#000');
        circle.setAttribute('stroke-width', '2');
    }

    // 在角色视图、台词视图和走位视图都启用拖拽
    const isDraggableView =
        BlockingApp.state.currentView === 'characters' ||
        BlockingApp.state.currentView === 'lines' ||
        BlockingApp.state.currentView === 'blocking';
    if (deletable && charName && isDraggableView) {
        // 只在坐标调整模式下显示可拖拽的光标
        circle.style.cursor = isCoordinateAdjustMode ? 'grab' : 'default';

        let isDragging = false;
        let startX = 0, startY = 0;

        // 拖拽开始
        circle.addEventListener('mousedown', (e) => {
            // 不在坐标调整模式时，让事件冒泡到 svg 处理（添加走位）
            if (!isCoordinateAdjustMode) {
                return;
            }

            e.stopPropagation();
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            // 多选模式下，点击未选中的点只选中不拖拽
            if (isMultiSelectMode && !isSelected) {
                // 不设置 draggingMarker，让 click 事件处理选中
                return;
            }

            // 如果在多选模式且当前点被选中，保存所有选中点的初始位置
            if (isMultiSelectMode && isSelected && selectedMarkers.length > 1) {
                saveSelectedMarkersPositions();
            }

            draggingMarker = {
                charName: charName,
                isInitial: isStart,
                movementIndex: movementIndex,
                startX: e.clientX,
                startY: e.clientY
            };
            circle.style.cursor = 'grabbing';
        });

        // 点击处理（多选或删除）
        circle.addEventListener('click', (e) => {
            // 不在坐标调整模式时，让事件冒泡到 svg 处理（添加走位）
            if (!isCoordinateAdjustMode) {
                return;
            }

            e.stopPropagation();
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);

            // 如果移动距离很小，视为点击
            if (dx < 5 && dy < 5) {
                if (isMultiSelectMode || e.shiftKey) {
                    // 多选模式：切换选中状态
                    toggleMarkerSelection(charName, isStart, movementIndex, x, y);
                } else {
                    // 普通模式：删除
                    deleteMarkerOnStage(x, y, charName, isStart);
                }
            }
        });

        circle.addEventListener('mouseenter', () => {
            if (!draggingMarker && !isSelected && isCoordinateAdjustMode) {
                circle.setAttribute('stroke', '#667eea');
                circle.setAttribute('stroke-width', '3');
            }
        });
        circle.addEventListener('mouseleave', () => {
            if (!draggingMarker && !isSelected) {
                circle.setAttribute('stroke', '#000');
                circle.setAttribute('stroke-width', '2');
            }
        });
    }

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', `${x}%`);
    text.setAttribute('y', `${y}%`);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#333');
    text.setAttribute('font-size', isStart ? '10' : '8');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('pointer-events', 'none');
    text.textContent = label;

    g.appendChild(circle);
    g.appendChild(text);
    svg.appendChild(g);
}

// 处理走位点拖拽
export function handleMarkerDrag(e, svg) {
    if (!draggingMarker) return;

    // 缩放模式
    if (isScalingMode) {
        handleScaling(e, svg);
        return;
    }

    const coords = getRelativeCoordinates(e, svg);
    const { charName, isInitial, movementIndex, startX, startY } = draggingMarker;

    // 检查被拖动的点是否在多选列表中
    const isDraggedMarkerSelected = isMultiSelectMode && selectedMarkers.length > 1 &&
        isMarkerSelected(charName, isInitial, movementIndex);

    if (isDraggedMarkerSelected) {
        // 多选拖拽：计算偏移量并应用到所有选中的点
        const svgRect = svg.getBoundingClientRect();
        const deltaX = (e.clientX - startX) / svgRect.width * 100;
        const deltaY = (e.clientY - startY) / svgRect.height * 100;

        selectedMarkers.forEach(marker => {
            const key = `${marker.charName}-${marker.isInitial}-${marker.movementIndex}`;
            const startPos = dragStartPositions[key];
            if (!startPos) return;

            const markerCharData = window.blockingData[window.currentScene.id]?.[marker.charName];
            if (!markerCharData) return;

            const newX = Math.max(0, Math.min(100, startPos.x + deltaX));
            const newY = Math.max(0, Math.min(100, startPos.y + deltaY));

            if (marker.isInitial && markerCharData.initial) {
                markerCharData.initial.x = newX;
                markerCharData.initial.y = newY;
            } else if (!marker.isInitial && markerCharData.movements && markerCharData.movements[marker.movementIndex]) {
                markerCharData.movements[marker.movementIndex].x = newX;
                markerCharData.movements[marker.movementIndex].y = newY;
            }

            // 走位视图使用快照渲染，拖拽时同步更新当前快照坐标
            if (BlockingApp.state.currentView === 'blocking' && BlockingApp.state.selectedBlockingSnapshot?.positions?.[marker.charName]) {
                BlockingApp.state.selectedBlockingSnapshot.positions[marker.charName].x = newX;
                BlockingApp.state.selectedBlockingSnapshot.positions[marker.charName].y = newY;
            }
        });
    } else {
        // 单点拖拽：原有逻辑
        const charData = window.blockingData[window.currentScene.id]?.[charName];
        if (!charData) return;

        if (isInitial) {
            // 拖拽初始位置
            if (charData.initial) {
                charData.initial.x = coords.x;
                charData.initial.y = coords.y;
            }
        } else if (movementIndex >= 0 && charData.movements && charData.movements[movementIndex]) {
            // 拖拽走位点
            charData.movements[movementIndex].x = coords.x;
            charData.movements[movementIndex].y = coords.y;
        }

        // 走位视图使用快照渲染，拖拽时同步更新当前快照坐标
        if (BlockingApp.state.currentView === 'blocking' && BlockingApp.state.selectedBlockingSnapshot?.positions?.[charName]) {
            BlockingApp.state.selectedBlockingSnapshot.positions[charName].x = coords.x;
            BlockingApp.state.selectedBlockingSnapshot.positions[charName].y = coords.y;
        }
    }

    renderStageView();
}

// 结束走位点拖拽
export function endMarkerDrag() {
    if (draggingMarker) {
        draggingMarker = null;
        autoSave();
        // 走位视图下重建快照序列，确保后续步骤也同步最新位置
        if (BlockingApp.state.currentView === 'blocking' && window.displayBlockingTimeline && window.selectBlockingStep) {
            const selectedStepIndex = BlockingApp.state.selectedBlockingSnapshot?.index || 0;
            window.displayBlockingTimeline(window.currentScene.id);
            window.selectBlockingStep(selectedStepIndex);
        }
    }
}

// ========== 坐标调整模式 ==========

// 切换坐标调整模式
export function toggleCoordinateAdjustMode() {
    isCoordinateAdjustMode = !isCoordinateAdjustMode;
    if (!isCoordinateAdjustMode) {
        // 退出调整模式时，同时退出多选模式
        isMultiSelectMode = false;
        selectedMarkers = [];
        dragStartPositions = {};
    }
    renderStageView();
    updateCoordinateAdjustUI();
    showStatus(isCoordinateAdjustMode ? '坐标调整模式：可拖动或删除走位点' : '已退出坐标调整模式', 'info');
}

// 获取坐标调整模式状态
export function getCoordinateAdjustMode() {
    return isCoordinateAdjustMode;
}

// 更新坐标调整模式UI
function updateCoordinateAdjustUI() {
    const adjustBtn = document.getElementById('coordinateAdjustBtn');
    const multiSelectBtn = document.getElementById('multiSelectBtn');

    if (adjustBtn) {
        adjustBtn.textContent = isCoordinateAdjustMode ? '退出调整' : '坐标调整';
        adjustBtn.classList.toggle('active', isCoordinateAdjustMode);
    }

    // 多选模式按钮只在坐标调整模式下可用
    if (multiSelectBtn) {
        multiSelectBtn.disabled = !isCoordinateAdjustMode;
        multiSelectBtn.style.opacity = isCoordinateAdjustMode ? '1' : '0.5';
    }

    updateMultiSelectUI();
}

// ========== 多选功能 ==========

// 切换多选模式
export function toggleMultiSelectMode() {
    isMultiSelectMode = !isMultiSelectMode;
    if (!isMultiSelectMode) {
        selectedMarkers = [];
        dragStartPositions = {};
    }
    renderStageView();
    updateMultiSelectUI();
    showStatus(isMultiSelectMode ? '多选模式：Shift+点击选择多个走位点' : '已退出多选模式', 'info');
}

// 添加/移除选中的走位点
function toggleMarkerSelection(charName, isInitial, movementIndex, x, y) {
    const index = selectedMarkers.findIndex(m =>
        m.charName === charName && m.isInitial === isInitial && m.movementIndex === movementIndex
    );

    if (index >= 0) {
        selectedMarkers.splice(index, 1);
    } else {
        selectedMarkers.push({ charName, isInitial, movementIndex, x, y });
    }
    updateMultiSelectUI();
    renderStageView();
}

// 清除所有选中
export function clearMarkerSelection() {
    selectedMarkers = [];
    dragStartPositions = {};
    updateMultiSelectUI();
    renderStageView();
}

// 获取选中数量
export function getSelectedMarkersCount() {
    return selectedMarkers.length;
}

// 检查某个标记是否被选中
function isMarkerSelected(charName, isInitial, movementIndex) {
    return selectedMarkers.some(m =>
        m.charName === charName && m.isInitial === isInitial && m.movementIndex === movementIndex
    );
}

// 更新多选UI状态
function updateMultiSelectUI() {
    const toolbar = document.getElementById('multiSelectToolbar');
    const countSpan = document.getElementById('selectionCount');
    const clearBtn = document.getElementById('clearSelectionBtn');
    const scaleBtn = document.getElementById('scaleBtn');
    const modeBtn = document.getElementById('multiSelectBtn');

    if (toolbar) {
        toolbar.style.display = 'flex';
    }
    if (countSpan) {
        countSpan.textContent = `已选择: ${selectedMarkers.length}`;
    }
    if (clearBtn) {
        clearBtn.disabled = selectedMarkers.length === 0;
    }
    if (scaleBtn) {
        scaleBtn.disabled = selectedMarkers.length < 2;
    }
    if (modeBtn) {
        modeBtn.textContent = isMultiSelectMode ? '退出多选' : '多选模式';
        modeBtn.classList.toggle('active', isMultiSelectMode);
    }
}

// 保存选中点的初始位置（用于多选拖拽）
function saveSelectedMarkersPositions() {
    dragStartPositions = {};
    selectedMarkers.forEach(marker => {
        const charData = window.blockingData[window.currentScene.id]?.[marker.charName];
        if (!charData) return;

        let pos;
        if (marker.isInitial && charData.initial) {
            pos = { x: charData.initial.x, y: charData.initial.y };
        } else if (!marker.isInitial && charData.movements && charData.movements[marker.movementIndex]) {
            pos = { x: charData.movements[marker.movementIndex].x, y: charData.movements[marker.movementIndex].y };
        }

        if (pos) {
            dragStartPositions[`${marker.charName}-${marker.isInitial}-${marker.movementIndex}`] = pos;
        }
    });
}

// ========== 缩放功能 ==========

// 计算选中点的中心
function calculateSelectionCenter() {
    if (selectedMarkers.length === 0) return null;

    let sumX = 0, sumY = 0;

    selectedMarkers.forEach(marker => {
        const charData = window.blockingData[window.currentScene.id]?.[marker.charName];
        if (!charData) return;

        if (marker.isInitial && charData.initial) {
            sumX += charData.initial.x;
            sumY += charData.initial.y;
        } else if (!marker.isInitial && charData.movements && charData.movements[marker.movementIndex]) {
            sumX += charData.movements[marker.movementIndex].x;
            sumY += charData.movements[marker.movementIndex].y;
        }
    });

    return {
        x: sumX / selectedMarkers.length,
        y: sumY / selectedMarkers.length
    };
}

// 计算选中点的边界框
function calculateBoundingBox() {
    if (selectedMarkers.length < 2) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    selectedMarkers.forEach(marker => {
        const charData = window.blockingData[window.currentScene.id]?.[marker.charName];
        if (!charData) return;

        let x, y;
        if (marker.isInitial && charData.initial) {
            x = charData.initial.x;
            y = charData.initial.y;
        } else if (!marker.isInitial && charData.movements && charData.movements[marker.movementIndex]) {
            x = charData.movements[marker.movementIndex].x;
            y = charData.movements[marker.movementIndex].y;
        } else {
            return;
        }

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });

    // 边界框至少有一定大小
    if (maxX - minX < 2) {
        minX -= 1;
        maxX += 1;
    }
    if (maxY - minY < 2) {
        minY -= 1;
        maxY += 1;
    }

    return { minX, minY, maxX, maxY };
}

// 绘制边界框和控制点
function drawBoundingBox(svg) {
    if (selectedMarkers.length < 2) return;

    boundingBox = calculateBoundingBox();
    if (!boundingBox) return;

    const { minX, minY, maxX, maxY } = boundingBox;
    const padding = 2;  // 边界框外扩一点

    const left = minX - padding;
    const top = minY - padding;
    const right = maxX + padding;
    const bottom = maxY + padding;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;

    // 绘制虚线边界框
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', `${left}%`);
    rect.setAttribute('y', `${top}%`);
    rect.setAttribute('width', `${right - left}%`);
    rect.setAttribute('height', `${bottom - top}%`);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', '#3b82f6');
    rect.setAttribute('stroke-width', '2');
    rect.setAttribute('stroke-dasharray', '6,4');
    rect.setAttribute('pointer-events', 'none');
    svg.appendChild(rect);

    // 8个控制点的位置和类型
    const handles = [
        { id: 'nw', x: left, y: top, cursor: 'nwse-resize' },
        { id: 'n', x: centerX, y: top, cursor: 'ns-resize' },
        { id: 'ne', x: right, y: top, cursor: 'nesw-resize' },
        { id: 'e', x: right, y: centerY, cursor: 'ew-resize' },
        { id: 'se', x: right, y: bottom, cursor: 'nwse-resize' },
        { id: 's', x: centerX, y: bottom, cursor: 'ns-resize' },
        { id: 'sw', x: left, y: bottom, cursor: 'nesw-resize' },
        { id: 'w', x: left, y: centerY, cursor: 'ew-resize' }
    ];

    handles.forEach(handle => {
        // 使用 g 元素包装，方便定位
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        // 使用 circle 替代 rect，因为 circle 的 cx/cy 支持百分比
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', `${handle.x}%`);
        circle.setAttribute('cy', `${handle.y}%`);
        circle.setAttribute('r', '6');
        circle.setAttribute('fill', 'white');
        circle.setAttribute('stroke', '#3b82f6');
        circle.setAttribute('stroke-width', '2');
        circle.setAttribute('style', `cursor: ${handle.cursor}`);
        circle.setAttribute('data-handle', handle.id);

        circle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            draggingHandle = handle.id;
            // 保存初始边界框，拖拽过程中不变
            initialBoundingBox = calculateBoundingBox();
            saveSelectedMarkersPositions();
        });

        g.appendChild(circle);
        svg.appendChild(g);
    });
}

// 处理边界框控制点拖拽
function handleBoundingBoxDrag(e, svg) {
    if (!draggingHandle || !initialBoundingBox || selectedMarkers.length < 2) return;

    const coords = getRelativeCoordinates(e, svg);
    // 使用拖拽开始时保存的初始边界框，而不是当前边界框
    const { minX, minY, maxX, maxY } = initialBoundingBox;

    // padding 要与 drawBoundingBox 中保持一致
    const padding = 2;

    // 计算缩放比例
    // 修正鼠标坐标：控制点绘制时加了 padding 偏移，需要还原到实际数据边界
    let scaleX = 1, scaleY = 1;
    let anchorX, anchorY;  // 缩放锚点

    // 计算距离的辅助函数
    const distance = (x1, y1, x2, y2) => Math.sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));

    switch (draggingHandle) {
        // 角落：等比例缩放
        // 使用数据边界（而非控制点位置）计算比例，确保数据点移动和控制点移动一致
        case 'nw': {
            anchorX = maxX; anchorY = maxY;
            // 初始数据边界角位置
            const dataCornerX = minX, dataCornerY = minY;
            // 鼠标位置对应的新数据边界角（减去 padding 偏移）
            const newCornerX = coords.x + padding, newCornerY = coords.y + padding;
            // 使用距离比计算等比例缩放
            const initDist = distance(anchorX, anchorY, dataCornerX, dataCornerY);
            const currDist = distance(anchorX, anchorY, newCornerX, newCornerY);
            scaleX = scaleY = currDist / initDist;
            break;
        }
        case 'ne': {
            anchorX = minX; anchorY = maxY;
            const dataCornerX = maxX, dataCornerY = minY;
            const newCornerX = coords.x - padding, newCornerY = coords.y + padding;
            const initDist = distance(anchorX, anchorY, dataCornerX, dataCornerY);
            const currDist = distance(anchorX, anchorY, newCornerX, newCornerY);
            scaleX = scaleY = currDist / initDist;
            break;
        }
        case 'se': {
            anchorX = minX; anchorY = minY;
            const dataCornerX = maxX, dataCornerY = maxY;
            const newCornerX = coords.x - padding, newCornerY = coords.y - padding;
            const initDist = distance(anchorX, anchorY, dataCornerX, dataCornerY);
            const currDist = distance(anchorX, anchorY, newCornerX, newCornerY);
            scaleX = scaleY = currDist / initDist;
            break;
        }
        case 'sw': {
            anchorX = maxX; anchorY = minY;
            const dataCornerX = minX, dataCornerY = maxY;
            const newCornerX = coords.x + padding, newCornerY = coords.y - padding;
            const initDist = distance(anchorX, anchorY, dataCornerX, dataCornerY);
            const currDist = distance(anchorX, anchorY, newCornerX, newCornerY);
            scaleX = scaleY = currDist / initDist;
            break;
        }
        // 边中点：单方向拉伸
        case 'n':
            anchorX = (minX + maxX) / 2; anchorY = maxY;
            scaleY = (maxY - (coords.y + padding)) / (maxY - minY);
            break;
        case 's':
            anchorX = (minX + maxX) / 2; anchorY = minY;
            scaleY = ((coords.y - padding) - minY) / (maxY - minY);
            break;
        case 'e':
            anchorX = minX; anchorY = (minY + maxY) / 2;
            scaleX = ((coords.x - padding) - minX) / (maxX - minX);
            break;
        case 'w':
            anchorX = maxX; anchorY = (minY + maxY) / 2;
            scaleX = (maxX - (coords.x + padding)) / (maxX - minX);
            break;
    }

    // 限制最小缩放
    scaleX = Math.max(0.1, scaleX);
    scaleY = Math.max(0.1, scaleY);

    // 应用变换到所有选中的点
    selectedMarkers.forEach(marker => {
        const key = `${marker.charName}-${marker.isInitial}-${marker.movementIndex}`;
        const startPos = dragStartPositions[key];
        if (!startPos) return;

        const charData = window.blockingData[window.currentScene.id]?.[marker.charName];
        if (!charData) return;

        // 相对于锚点的偏移量
        const dx = startPos.x - anchorX;
        const dy = startPos.y - anchorY;

        // 应用缩放
        const newX = Math.max(0, Math.min(100, anchorX + dx * scaleX));
        const newY = Math.max(0, Math.min(100, anchorY + dy * scaleY));

        if (marker.isInitial && charData.initial) {
            charData.initial.x = newX;
            charData.initial.y = newY;
        } else if (!marker.isInitial && charData.movements && charData.movements[marker.movementIndex]) {
            charData.movements[marker.movementIndex].x = newX;
            charData.movements[marker.movementIndex].y = newY;
        }
    });

    renderStageView();
}

// 结束边界框拖拽
function endBoundingBoxDrag() {
    if (draggingHandle) {
        draggingHandle = null;
        initialBoundingBox = null;  // 清除初始边界框
        autoSave();
    }
}

// 开始缩放模式
export function startScaling() {
    if (selectedMarkers.length < 2) {
        showStatus('请至少选择2个走位点才能缩放', 'warning');
        return;
    }

    isScalingMode = !isScalingMode;

    if (isScalingMode) {
        scaleCenter = calculateSelectionCenter();
        saveSelectedMarkersPositions();
        showStatus('缩放模式：拖动任意选中点进行缩放（再次点击退出）', 'info');
    } else {
        scaleCenter = null;
        showStatus('已退出缩放模式', 'info');
    }

    updateScalingUI();
}

// 更新缩放UI
function updateScalingUI() {
    const scaleBtn = document.getElementById('scaleBtn');
    if (scaleBtn) {
        scaleBtn.textContent = isScalingMode ? '退出缩放' : '缩放选中';
        scaleBtn.classList.toggle('active', isScalingMode);
    }
}

// 处理缩放拖拽
function handleScaling(e, svg) {
    if (!isScalingMode || !scaleCenter || selectedMarkers.length < 2) return;

    const coords = getRelativeCoordinates(e, svg);

    // 计算当前鼠标到中心的距离
    const currentDist = Math.sqrt(
        Math.pow(coords.x - scaleCenter.x, 2) +
        Math.pow(coords.y - scaleCenter.y, 2)
    );

    // 获取任意一个起始点到中心的距离作为参考
    const firstKey = Object.keys(dragStartPositions)[0];
    const firstPos = dragStartPositions[firstKey];
    if (!firstPos) return;

    const initialDist = Math.sqrt(
        Math.pow(firstPos.x - scaleCenter.x, 2) +
        Math.pow(firstPos.y - scaleCenter.y, 2)
    );

    if (initialDist < 1) return;  // 避免除以零

    const scale = currentDist / initialDist;

    // 应用缩放到所有选中的点
    selectedMarkers.forEach(marker => {
        const key = `${marker.charName}-${marker.isInitial}-${marker.movementIndex}`;
        const startPos = dragStartPositions[key];
        if (!startPos) return;

        const markerCharData = window.blockingData[window.currentScene.id]?.[marker.charName];
        if (!markerCharData) return;

        // 相对于中心的偏移量
        const dx = startPos.x - scaleCenter.x;
        const dy = startPos.y - scaleCenter.y;

        // 应用缩放
        const newX = Math.max(0, Math.min(100, scaleCenter.x + dx * scale));
        const newY = Math.max(0, Math.min(100, scaleCenter.y + dy * scale));

        if (marker.isInitial && markerCharData.initial) {
            markerCharData.initial.x = newX;
            markerCharData.initial.y = newY;
        } else if (!marker.isInitial && markerCharData.movements && markerCharData.movements[marker.movementIndex]) {
            markerCharData.movements[marker.movementIndex].x = newX;
            markerCharData.movements[marker.movementIndex].y = newY;
        }
    });

    renderStageView();
}

// 绘制箭头（支持弧线）
export function drawArrow(svg, x1, y1, x2, y2, color, controlPoint = null, arrowMeta = null) {
    // 确保 defs 存在
    let defs = svg.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.appendChild(defs);
    }

    const markerId = `arrowhead-${color.replace('#', '')}`;
    if (!svg.querySelector(`#${markerId}`)) {
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', markerId);
        marker.setAttribute('markerWidth', '10');
        marker.setAttribute('markerHeight', '10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        marker.setAttribute('markerUnits', 'strokeWidth');

        const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        markerPath.setAttribute('d', 'M0,0 L0,6 L9,3 z');
        markerPath.setAttribute('fill', color);

        marker.appendChild(markerPath);
        defs.appendChild(marker);
    }

    if (controlPoint) {
        // controlPoint 存储的是曲线要经过的点（midPoint）
        // 需要反算出贝塞尔控制点：bezierControl = 2 * midPoint - 0.5 * start - 0.5 * end
        const bezierCtrlX = 2 * controlPoint.x - 0.5 * x1 - 0.5 * x2;
        const bezierCtrlY = 2 * controlPoint.y - 0.5 * y1 - 0.5 * y2;

        // 绘制二次贝塞尔曲线
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const svgRect = svg.getBoundingClientRect();
        const toAbs = (pct, size) => (pct / 100) * size;

        const ax1 = toAbs(x1, svgRect.width), ay1 = toAbs(y1, svgRect.height);
        const ax2 = toAbs(x2, svgRect.width), ay2 = toAbs(y2, svgRect.height);
        const abcx = toAbs(bezierCtrlX, svgRect.width), abcy = toAbs(bezierCtrlY, svgRect.height);

        path.setAttribute('d', `M ${ax1} ${ay1} Q ${abcx} ${abcy} ${ax2} ${ay2}`);
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '3');
        path.setAttribute('fill', 'none');
        path.setAttribute('marker-end', `url(#${markerId})`);
        path.classList.add('movement-arrow');

        // 点击曲线可以编辑（角色视图和台词视图都支持）
        if (arrowMeta && (BlockingApp.state.currentView === 'characters' || BlockingApp.state.currentView === 'lines')) {
            path.style.cursor = 'pointer';
            path.addEventListener('click', (e) => {
                e.stopPropagation();
                selectArrowForCurveEdit(arrowMeta.charName, arrowMeta.movementIndex);
            });
        }

        svg.appendChild(path);

        // 绘制可拖拽的点（显示在曲线经过的位置，即 controlPoint）
        if (selectedArrowForCurve && arrowMeta &&
            selectedArrowForCurve.charName === arrowMeta.charName &&
            selectedArrowForCurve.movementIndex === arrowMeta.movementIndex) {
            const midPxX = toAbs(controlPoint.x, svgRect.width);
            const midPxY = toAbs(controlPoint.y, svgRect.height);
            drawControlPoint(svg, midPxX, midPxY, color, arrowMeta, true);
        }
    } else {
        // 绘制直线
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', `${x1}%`);
        line.setAttribute('y1', `${y1}%`);
        line.setAttribute('x2', `${x2}%`);
        line.setAttribute('y2', `${y2}%`);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '3');
        line.setAttribute('marker-end', `url(#${markerId})`);
        line.classList.add('movement-arrow');

        // 点击直线可以添加弧度（角色视图和台词视图都支持）
        if (arrowMeta && (BlockingApp.state.currentView === 'characters' || BlockingApp.state.currentView === 'lines')) {
            line.style.cursor = 'pointer';
            line.addEventListener('click', (e) => {
                e.stopPropagation();
                // 在线中点创建控制点
                addControlPointToArrow(arrowMeta.charName, arrowMeta.movementIndex, x1, y1, x2, y2);
            });
        }

        svg.appendChild(line);
    }
}

// 绘制控制点（可拖拽）
function drawControlPoint(svg, x, y, color, arrowMeta, usePixels = false) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('control-point-group');

    // 控制点圆圈
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', usePixels ? x : `${x}%`);
    circle.setAttribute('cy', usePixels ? y : `${y}%`);
    circle.setAttribute('r', '10');
    circle.setAttribute('fill', 'white');
    circle.setAttribute('stroke', color);
    circle.setAttribute('stroke-width', '3');
    circle.style.cursor = isCoordinateAdjustMode ? 'grab' : 'default';

    // 拖拽事件（仅在坐标调整模式下生效）
    circle.addEventListener('mousedown', (e) => {
        if (!isCoordinateAdjustMode) {
            return;  // 让事件冒泡到 svg
        }
        e.stopPropagation();
        draggingControlPoint = {
            charName: arrowMeta.charName,
            movementIndex: arrowMeta.movementIndex
        };
        circle.style.cursor = 'grabbing';
    });

    // 删除控制点按钮（位置偏移也要用像素）
    const deleteBtn = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    if (usePixels) {
        deleteBtn.setAttribute('x', x + 15);
        deleteBtn.setAttribute('y', y - 15);
    } else {
        deleteBtn.setAttribute('x', `${x + 2}%`);
        deleteBtn.setAttribute('y', `${y - 3}%`);
    }
    deleteBtn.setAttribute('fill', '#ef4444');
    deleteBtn.setAttribute('font-size', '14');
    deleteBtn.setAttribute('font-weight', 'bold');
    deleteBtn.setAttribute('cursor', 'pointer');
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeControlPoint(arrowMeta.charName, arrowMeta.movementIndex);
    });

    g.appendChild(circle);
    g.appendChild(deleteBtn);
    svg.appendChild(g);
}

// 为直线添加控制点（变成弧线）
function addControlPointToArrow(charName, movementIndex, x1, y1, x2, y2) {
    const charData = window.blockingData[window.currentScene.id]?.[charName];
    if (!charData) return;

    // 控制点初始在线的中点
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    const controlPoint = {
        x: midX,
        y: midY
    };

    if (movementIndex === -1) {
        // 从初始位置到第一个走位的箭头
        if (charData.movements && charData.movements.length > 0) {
            charData.movements[0].controlPointFromPrev = controlPoint;
        }
    } else {
        if (charData.movements && charData.movements[movementIndex]) {
            charData.movements[movementIndex].controlPointFromPrev = controlPoint;
        }
    }

    selectedArrowForCurve = { charName, movementIndex };
    autoSave();
    renderStageView();
}

// 删除控制点（弧线变回直线）
function removeControlPoint(charName, movementIndex) {
    const charData = window.blockingData[window.currentScene.id]?.[charName];
    if (!charData) return;

    if (movementIndex === -1) {
        if (charData.movements && charData.movements.length > 0) {
            delete charData.movements[0].controlPointFromPrev;
        }
    } else {
        if (charData.movements && charData.movements[movementIndex]) {
            delete charData.movements[movementIndex].controlPointFromPrev;
        }
    }

    selectedArrowForCurve = null;
    autoSave();
    renderStageView();
}

// 选择箭头进行弧度编辑
function selectArrowForCurveEdit(charName, movementIndex) {
    if (selectedArrowForCurve &&
        selectedArrowForCurve.charName === charName &&
        selectedArrowForCurve.movementIndex === movementIndex) {
        // 再次点击取消选中
        selectedArrowForCurve = null;
    } else {
        selectedArrowForCurve = { charName, movementIndex };
    }
    renderStageView();
}

// 处理控制点拖拽
export function handleControlPointDrag(e, svg) {
    if (!draggingControlPoint) return;

    const coords = getRelativeCoordinates(e, svg);
    const { charName, movementIndex } = draggingControlPoint;
    const charData = window.blockingData[window.currentScene.id]?.[charName];

    if (!charData) return;

    if (movementIndex === -1) {
        if (charData.movements && charData.movements.length > 0) {
            charData.movements[0].controlPointFromPrev = { x: coords.x, y: coords.y };
        }
    } else {
        if (charData.movements && charData.movements[movementIndex]) {
            charData.movements[movementIndex].controlPointFromPrev = { x: coords.x, y: coords.y };
        }
    }

    renderStageView();
}

// 结束控制点拖拽
export function endControlPointDrag() {
    if (draggingControlPoint) {
        draggingControlPoint = null;
        autoSave();
    }
}

// 自动保存
export function autoSave() {
    // 保存修改前的状态到历史（用于撤销）
    if (window.pushHistory) {
        window.pushHistory();
    }

    updateSaveStatus('saving');

    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(() => {
        BlockingApp.state.isLoadingFromFirebase = true;
        blockingRef.set(window.blockingData)
            .then(() => {
                updateSaveStatus('synced');
                BlockingApp.state.isLoadingFromFirebase = false;
                // 更新状态栏
                if (window.updateSceneStats) window.updateSceneStats();
                // 更新"上一次保存的状态"（用于下次撤销）
                if (window.updateLastSavedState) window.updateLastSavedState();
            })
            .catch((error) => {
                console.error('Firebase保存失败:', error);
                updateSaveStatus('error');
                BlockingApp.state.isLoadingFromFirebase = false;
            });
    }, 1000);
}

// 删除走位（从台词视图）
export function deleteMovement(lineId, charIndex, targetCharacterName = null, targetTimestamp = null) {
    if (!confirm('确定要删除这个走位标记吗？')) return;

    const sceneId = window.currentScene.id;
    const sceneData = window.blockingData[sceneId] || {};

    let deleted = false;
    Object.keys(sceneData).forEach(charName => {
        if (deleted) return;
        if (targetCharacterName && charName !== targetCharacterName) return;

        const charData = sceneData[charName];
        if (!charData.movements) return;

        const index = charData.movements.findIndex((m) => {
            if (m.lineId !== lineId || m.charIndex !== charIndex) return false;
            if (targetTimestamp) return m.timestamp === targetTimestamp;
            return true;
        });

        if (index !== -1) {
            charData.movements.splice(index, 1);
            autoSave();
            showStatus(`已删除走位标记`, 'success');
            if (window.displayLines) window.displayLines(sceneId);
            renderStageView();
            deleted = true;
        }
    });
}

// 删除舞台上的标记
export function deleteMarkerOnStage(x, y, charName, isStart) {
    if (isStart) {
        if (!confirm(`确定要删除 ${charName} 的初始位置吗？`)) return;

        const charData = window.blockingData[window.currentScene.id]?.[charName];
        if (charData) {
            charData.initial = null;
            // 如果没有其他走位，删除整个角色数据
            if (!charData.movements || charData.movements.length === 0) {
                delete window.blockingData[window.currentScene.id][charName];
            }
        }
        autoSave();
        showStatus(`已删除 ${charName} 的初始位置`, 'success');
    } else {
        if (!confirm(`确定要删除这个走位点吗？`)) return;

        const charData = window.blockingData[window.currentScene.id]?.[charName];
        if (charData && charData.movements) {
            const index = charData.movements.findIndex(m =>
                Math.abs(m.x - x) < 0.1 && Math.abs(m.y - y) < 0.1
            );

            if (index !== -1) {
                charData.movements.splice(index, 1);
                autoSave();
                showStatus(`已删除走位点`, 'success');
            }
        }
    }

    renderStageView();
    if (BlockingApp.state.currentView === 'characters') {
        if (window.displayCharacters) {
            window.displayCharacters(window.currentScene.id);
        }
        // 更新走位列表
        if (window.renderMovementsList && BlockingApp.state.selectedCharacter) {
            const container = document.getElementById('movementsListContainer');
            if (container) {
                container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
            }
        }
    }
}

// 开始添加自由走位
export function startAddFreeMovement() {
    BlockingApp.state.addingFreeMovement = true;
    showStatus('自由走位模式：请在stage-layouts上点击添加位置', 'info');
}

// 添加自由走位
export function addFreeMovementToCharacter(x, y) {
    if (!BlockingApp.state.selectedCharacter || !window.currentScene) return;

    const sceneId = window.currentScene.id;
    if (!window.blockingData[sceneId]) {
        window.blockingData[sceneId] = {};
    }
    if (!window.blockingData[sceneId][BlockingApp.state.selectedCharacter]) {
        window.blockingData[sceneId][BlockingApp.state.selectedCharacter] = { initial: null, movements: [] };
    }
    if (!window.blockingData[sceneId][BlockingApp.state.selectedCharacter].movements) {
        window.blockingData[sceneId][BlockingApp.state.selectedCharacter].movements = [];
    }

    window.blockingData[sceneId][BlockingApp.state.selectedCharacter].movements.push({
        x: x,
        y: y,
        timestamp: Date.now(),
        type: 'free'
    });

    autoSave();
    showStatus(`已添加 ${BlockingApp.state.selectedCharacter} 的自由走位`, 'success');

    renderStageView();
    if (window.renderMovementsList) {
        const container = document.getElementById('movementsListContainer');
        if (container) {
            container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
        }
    }
}

// 删除自由走位
export function deleteFreeMovement(movementIndex) {
    if (!confirm('确定要删除这个走位吗？')) return;

    const charData = window.blockingData[window.currentScene.id]?.[BlockingApp.state.selectedCharacter];
    if (charData && charData.movements && charData.movements[movementIndex]) {
        charData.movements.splice(movementIndex, 1);
        autoSave();
        showStatus(`已删除走位`, 'success');

        renderStageView();
        if (window.renderMovementsList) {
            const container = document.getElementById('movementsListContainer');
            if (container) {
                container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
            }
        }
    }
}

// 渲染走位列表
export function renderMovementsList(characterName) {
    const charData = window.blockingData[window.currentScene.id]?.[characterName];
    if (!charData) {
        return `<div class="movements-empty">暂无走位数据</div>
                <button class="add-free-movement-btn" onclick="startAddFreeMovement()">➕ 添加自由走位</button>`;
    }

    const sortedMovements = charData.movements ? [...charData.movements] : [];
    sortMovements(sortedMovements);

    let html = `<div class="movements-header">
        <h4>${characterName} 的走位列表</h4>
        <button class="add-free-movement-btn" onclick="startAddFreeMovement()">➕ 添加自由走位</button>
    </div>`;

    if (charData.initial) {
        html += `<div class="movement-item initial">
            <span class="movement-label">🏠 初始位置</span>
        </div>`;
    }

    sortedMovements.forEach((movement, index) => {
        const realIndex = charData.movements.indexOf(movement);
        const isLinked = movement.lineId && movement.charIndex !== undefined;
        const hasCurve = !!movement.controlPointFromPrev;

        // 获取格式化的台词显示
        const labelText = isLinked
            ? `📍 ${getFormattedLineDisplay(movement.lineId, movement.charIndex)}`
            : '🔹 自由走位';

        // 备注显示
        const noteDisplay = movement.note
            ? `<div class="movement-note">📝 ${movement.note}</div>`
            : '';

        // 弧线标记
        const curveTag = hasCurve ? '<span class="curve-tag">⤴ 弧线</span>' : '';

        html += `<div class="movement-item ${isLinked ? 'linked' : 'free'}">
            <div class="movement-main">
                <span class="movement-label" title="${isLinked ? movement.lineId + '[' + movement.charIndex + ']' : ''}">
                    ${labelText} ${curveTag}
                </span>
                ${noteDisplay}
            </div>
            <span class="movement-actions">
                <button onclick="showMovementNoteModal(${realIndex})" title="添加备注">📝</button>
                ${!isLinked ? `<button onclick="showLineAssociationModal(${realIndex})">关联台词</button>` : `<button onclick="unlinkMovement(${realIndex})">取消关联</button>`}
                <button class="delete-btn" onclick="deleteFreeMovement(${realIndex})">×</button>
            </span>
        </div>`;
    });

    return html;
}

// 显示走位备注模态框
export function showMovementNoteModal(movementIndex) {
    editingMovementIndex = movementIndex;
    const charData = window.blockingData[window.currentScene.id]?.[BlockingApp.state.selectedCharacter];
    if (!charData || !charData.movements || !charData.movements[movementIndex]) return;

    const movement = charData.movements[movementIndex];
    const modal = document.getElementById('movementNoteModal');
    const input = document.getElementById('movementNoteInput');

    // 填充现有备注
    input.value = movement.note || '';

    // 渲染常用动作和舞台方位
    if (window.renderCommonActionsChips) {
        window.renderCommonActionsChips('movementCommonActionsContainer', 'movementNoteInput');
    }
    if (window.renderStageDirections) {
        window.renderStageDirections('movementStageDirectionContainer', 'movementNoteInput');
    }

    modal.classList.add('active');
    input.focus();
}

// 保存走位备注
export function saveMovementNote() {
    const charData = window.blockingData[window.currentScene.id]?.[BlockingApp.state.selectedCharacter];
    if (!charData || !charData.movements || editingMovementIndex === null) return;

    const input = document.getElementById('movementNoteInput');
    const note = input.value.trim();

    if (note) {
        charData.movements[editingMovementIndex].note = note;
    } else {
        delete charData.movements[editingMovementIndex].note;
    }

    autoSave();
    closeMovementNoteModal();
    showStatus('备注已保存', 'success');

    // 刷新走位列表
    if (window.renderMovementsList) {
        const container = document.getElementById('movementsListContainer');
        if (container) {
            container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
        }
    }
}

// 关闭走位备注模态框
export function closeMovementNoteModal() {
    document.getElementById('movementNoteModal').classList.remove('active');
    editingMovementIndex = null;
}

// 显示台词关联模态框
export function showLineAssociationModal(movementIndex) {
    editingMovementIndex = movementIndex;
    const modal = document.getElementById('lineAssociationModal');
    const lineList = document.getElementById('lineList');

    const sceneLines = BlockingApp.data.lines.filter(line =>
        line.sceneId === window.currentScene.id && !line.isStageDirection
    );

    lineList.innerHTML = sceneLines.map((line, idx) => {
        const lineId = `${line.sceneId}-${line.originalIndex}`;
        return `<div class="line-option" onclick="selectLineForAssociation('${lineId}')">
            <span class="line-character">${line.character}</span>
            <span class="line-text">${line.content.substring(0, 30)}${line.content.length > 30 ? '...' : ''}</span>
        </div>`;
    }).join('');

    modal.classList.add('active');
}

// 选择关联台词
export function selectLineForAssociation(lineId) {
    document.querySelectorAll('.line-option').forEach(el => el.classList.remove('selected'));
    event.target.closest('.line-option').classList.add('selected');
    selectedLineForAssociation = lineId;
}

// 确认台词关联
export function confirmLineAssociation() {
    if (!selectedLineForAssociation) {
        alert('请先选择一个台词');
        return;
    }

    // 先保存选中的台词ID，因为 closeLineAssociationModal 会重置它
    pendingLineIdForCharPosition = selectedLineForAssociation;
    closeLineAssociationModal();
    showCharacterPositionModal(pendingLineIdForCharPosition);
}

// 关闭台词关联模态框
export function closeLineAssociationModal() {
    document.getElementById('lineAssociationModal').classList.remove('active');
    selectedLineForAssociation = null;
}

// 显示字符位置选择模态框
export function showCharacterPositionModal(lineId) {
    const modal = document.getElementById('characterPositionModal');
    const contentDiv = document.getElementById('selectedLineContent');
    const charDiv = document.getElementById('charPosLineCharacter');

    const line = BlockingApp.data.lines.find(l => `${l.sceneId}-${l.originalIndex}` === lineId);
    if (!line) {
        alert('找不到对应的台词');
        return;
    }

    charDiv.textContent = line.character;
    contentDiv.innerHTML = line.content.split('').map((char, idx) =>
        `<span class="char-selectable" onclick="selectCharacterPosition(${idx})">${char}</span>`
    ).join('');

    modal.classList.add('active');
}

// 选择字符位置
export function selectCharacterPosition(charIndex) {
    const charData = window.blockingData[window.currentScene.id]?.[BlockingApp.state.selectedCharacter];
    if (!charData || !charData.movements || editingMovementIndex === null) return;

    if (!pendingLineIdForCharPosition) {
        showStatus('未选择台词，请重新操作', 'error');
        closeCharacterPositionModal();
        return;
    }

    charData.movements[editingMovementIndex].lineId = pendingLineIdForCharPosition;
    charData.movements[editingMovementIndex].charIndex = charIndex;
    charData.movements[editingMovementIndex].type = 'line';

    autoSave();
    closeCharacterPositionModal();
    showStatus('已关联到台词', 'success');

    renderStageView();
    if (window.renderMovementsList) {
        const container = document.getElementById('movementsListContainer');
        if (container) {
            container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
        }
    }
}

// 关闭字符位置模态框
export function closeCharacterPositionModal() {
    document.getElementById('characterPositionModal').classList.remove('active');
    editingMovementIndex = null;
    pendingLineIdForCharPosition = null;  // 清理状态
}

// 取消关联
export function unlinkMovement(movementIndex) {
    const charData = window.blockingData[window.currentScene.id]?.[BlockingApp.state.selectedCharacter];
    if (!charData || !charData.movements) return;

    delete charData.movements[movementIndex].lineId;
    delete charData.movements[movementIndex].charIndex;
    charData.movements[movementIndex].type = 'free';

    autoSave();
    showStatus('已取消台词关联', 'success');

    renderStageView();
    if (window.renderMovementsList) {
        const container = document.getElementById('movementsListContainer');
        if (container) {
            container.innerHTML = window.renderMovementsList(BlockingApp.state.selectedCharacter);
        }
    }
}

// 不再需要这些函数 - 现在统一使用 BlockingApp.state

// 挂载到 window
window.startSetInitial = startSetInitial;
window.selectInitialCharacter = selectInitialCharacter;
window.confirmInitialCharacter = confirmInitialCharacter;
window.handleStageClick = handleStageClick;
window.showCharacterModal = showCharacterModal;
window.closeCharacterModal = closeCharacterModal;
window.selectCharacterAction = selectCharacterAction;
window.renderStageView = renderStageView;
window.renderCharacterTrajectory = renderCharacterTrajectory;
window.deleteMovement = deleteMovement;
window.startAddFreeMovement = startAddFreeMovement;
window.deleteFreeMovement = deleteFreeMovement;
window.renderMovementsList = renderMovementsList;
window.showLineAssociationModal = showLineAssociationModal;
window.selectLineForAssociation = selectLineForAssociation;
window.confirmLineAssociation = confirmLineAssociation;
window.closeLineAssociationModal = closeLineAssociationModal;
window.selectCharacterPosition = selectCharacterPosition;
window.closeCharacterPositionModal = closeCharacterPositionModal;
window.unlinkMovement = unlinkMovement;
window.updateSaveStatus = updateSaveStatus;
// 走位备注
window.showMovementNoteModal = showMovementNoteModal;
window.saveMovementNote = saveMovementNote;
window.closeMovementNoteModal = closeMovementNoteModal;
// 弧线控制点
window.handleControlPointDrag = handleControlPointDrag;
window.endControlPointDrag = endControlPointDrag;
// 走位点拖拽
window.handleMarkerDrag = handleMarkerDrag;
window.endMarkerDrag = endMarkerDrag;
// 边界框拖拽
window.handleBoundingBoxDrag = handleBoundingBoxDrag;
window.endBoundingBoxDrag = endBoundingBoxDrag;
// 坐标调整模式
window.toggleCoordinateAdjustMode = toggleCoordinateAdjustMode;
// 多选功能
window.toggleMultiSelectMode = toggleMultiSelectMode;
window.clearMarkerSelection = clearMarkerSelection;
window.getSelectedMarkersCount = getSelectedMarkersCount;
// 缩放功能
window.startScaling = startScaling;
