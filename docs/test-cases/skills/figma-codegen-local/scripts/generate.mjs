#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';

/**
 * 图片下载工具函数
 */
/**
 * 判断两个 SVG path 内容是否"相同"
 * 这里改为【严格相等】判断，避免把飞书 / 钉钉 / 企业微信这类不同图标误判为同一个。
 * 如果只是几倍像素但 Figma 输出的 path 一样（只改 width/height/viewBox），依然会被认为是同一个图标。
 */
function areSvgPathsSimilar(path1, path2) {
    return path1.trim() === path2.trim();
}
/**
 * 归一化 SVG 内容用于比较。
 * 这里直接使用完整 SVG 文本（去掉前后空白），避免只看第一个 path 把不同图标误判成相同。
 */
function extractSvgPathData(svgContent) {
    // 归一化 Figma 自动生成的 id，避免同图标因随机后缀不同而被认为是不同文件
    const normalizeIds = (content) => content
        .replace(/id="(pattern|clip|image)[^"]*"/g, 'id="$1"')
        .replace(/url\(#(pattern|clip)[^)]+\)/g, 'url(#$1)')
        .replace(/(xlink:href|href)="#(image)[^"]*"/g, '$1="#$2"');
    const normalized = normalizeIds(svgContent.trim());
    // 提取 <image> 定义里的 base64，做出 id -> href 的映射
    const images = {};
    const imageRegex = /<image[^>]*\sid="([^"]+)"[^>]*?\s(?:xlink:href|href)="([^"]+)"[^>]*>/g;
    let imageMatch;
    while ((imageMatch = imageRegex.exec(normalized))) {
        const [, id, href] = imageMatch;
        images[id] = href;
    }
    // 提取 <use xlink:href="#image" transform="...">，用真实 href + transform 归一化
    const uses = [];
    const useRegex = /<use[^>]*\s(?:xlink:href|href)="([^"]+)"([^>]*)>/g;
    let useMatch;
    while ((useMatch = useRegex.exec(normalized))) {
        const [, ref, tail] = useMatch;
        const targetId = ref.replace(/^#/, '');
        const href = images[targetId] ?? ref;
        const transformMatch = /transform="([^"]+)"/.exec(tail);
        const transform = transformMatch ? transformMatch[1].trim() : '';
        uses.push(`${href}|${transform}`);
    }
    // 提取基础填充色（背景色），避免不同底色被误判相同
    const fills = Array.from(new Set(Array.from(normalized.matchAll(/<rect[^>]*\sfill="([^"]+)"/g)).map((m) => m[1])));
    // 用结构化 JSON 保证比较稳定，便于判重
    return JSON.stringify({
        fills: fills.sort(),
        uses: Array.from(new Set(uses)).sort(),
        images: Object.values(images).sort(),
        meta: {
            size: normalized.match(/viewBox="([^"]+)"/)?.[1] ?? '',
            width: normalized.match(/<svg[^>]*\swidth="([^"]+)"/)?.[1] ?? '',
            height: normalized.match(/<svg[^>]*\sheight="([^"]+)"/)?.[1] ?? '',
        },
    });
}
/**
 * 通过 Figma Images API 获取图片 URL
 *
 * PNG 默认使用 `scale=2`，与 1x 设计尺寸相比输出约 2 倍像素，避免整图导出（如 img_/group_）发糊。
 * SVG 仍为矢量，不附加 scale。
 *
 * PNG 默认附带 `use_absolute_bounds=true`，避免导出尺寸只剩「内容紧包围」而丢掉 Frame 内留白（与画布不一致）。
 *
 * @param token - Figma API Token
 * @param fileKey - Figma 文件 Key
 * @param nodeIds - 节点 ID 数组
 * @param format - 图片格式：'png' 或 'svg'
 * @param options - scale / useAbsoluteBounds / contentsOnly
 * @returns 图片 URL 映射对象 { nodeId: imageUrl }
 */
async function getFigmaImageUrls(token, fileKey, nodeIds, format = 'png', options) {
    if (nodeIds.length === 0)
        return {};
    const rasterScale = format === 'png' ? (options?.scale ?? 2) : undefined;
    const useAbsoluteBounds = options?.useAbsoluteBounds ?? (format === 'png');
    const contentsOnly = options?.contentsOnly;
    const u = new URL(`https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}`);
    u.searchParams.set('ids', nodeIds.join(','));
    u.searchParams.set('format', format);
    if (rasterScale !== undefined && rasterScale !== 1) {
        u.searchParams.set('scale', String(rasterScale));
    }
    u.searchParams.set('use_absolute_bounds', useAbsoluteBounds ? 'true' : 'false');
    if (contentsOnly !== undefined) {
        u.searchParams.set('contents_only', contentsOnly ? 'true' : 'false');
    }
    const url = u.toString();
    const res = await fetch(url, {
        headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
        // 检测 token 过期（401 Unauthorized）
        if (res.status === 401) {
            const error = new Error('Figma Token 已过期');
            error.isTokenExpired = true;
            throw error;
        }
        throw new Error(`Figma API 失败: ${res.status} ${await res.text()}`);
    }
    return (await res.json()).images || {};
}
/**
 * 通过 Figma "Get image fills" API 获取图片填充（imageRef）的原始 URL
 *
 * 说明：
 * - node images API 会渲染整个节点（会把子节点一起渲染进去），不适合“只取背景图（fill）”的场景
 * - image fills API 返回 imageRef -> **素材原图 URL**；Figma 画布上的裁切/圆角/fill 变换需用节点 JSON 自行还原，
 *   与「导出该节点为 PNG」的视觉效果可能不一致，属 API 限制。
 *
 * @param token - Figma API Token
 * @param fileKey - Figma 文件 Key
 * @param imageRefs - imageRef 数组（来自 fills[].imageRef）
 * @returns 映射 { imageRef: url }
 */
async function getFigmaImageFillUrls(token, fileKey, imageRefs) {
    if (imageRefs.length === 0)
        return {};
    const url = `https://api.figma.com/v1/files/${fileKey}/images`;
    const res = await fetch(url, {
        headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
        if (res.status === 401) {
            const error = new Error('Figma Token 已过期');
            error.isTokenExpired = true;
            throw error;
        }
        throw new Error(`Figma API 失败: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json());
    const images = json?.meta?.images || {};
    const result = {};
    for (const ref of imageRefs) {
        if (images[ref])
            result[ref] = images[ref];
    }
    return result;
}

/**
 * 从 Figma API 获取节点数据
 *
 * API 格式: GET https://api.figma.com/v1/files/{file_key}/nodes?ids={node_ids}
 *
 * @param token - Figma API Token
 * @param nodeId - 节点 ID，格式可以是 file_key-node_id 或单独的 node_id
 * @param url - 完整的 API URL（可选，如果提供则直接使用）
 * @param fileKey - 文件 Key（可选，如果 nodeId 不包含 file_key 则需要提供）
 */
async function fetchFigmaNodes(token, nodeId, fileKey) {
    // 统一处理 URL：如果提供了完整 URL 就用，否则从 nodeId 和 fileKey 构建
    const apiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`;
    console.error(`正在调用 Figma API: ${apiUrl}`);
    const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
            'X-Figma-Token': token,
        },
    });
    if (!response.ok) {
        // 检测 token 过期（401 Unauthorized）
        if (response.status === 401) {
            const error = new Error('Figma Token 已过期');
            error.isTokenExpired = true;
            throw error;
        }
        const errorText = await response.text();
        throw new Error(`Figma API 请求失败: ${response.status} ${response.statusText}\n${errorText}`);
    }
    const nodeData = await response.json();
    console.error('✓ 成功获取节点数据');
    return nodeData;
}

/**
 * 常量定义
 */
const NODE_FIELD_WHITELIST = [
    'id',
    'name',
    'type',
    'visible',
    // filter 阶段用于标记表单控件类型，必须保留，否则后续会误抽成 icon/image
    '_formControlType',
    // filter 阶段从 TEXT 节点提取的 placeholder（给 input/textarea 等用），必须保留到 AST
    '_placeholder',
    // filter 阶段用于标记组件库组件类型（通过 componentId -> components.name 识别），必须保留到 AST
    '_libraryComponentType',
    // filter 阶段：Figma 组件变体名（components[componentId].name），供 AST componentDesc
    '_componentDesc',
    /** INSTANCE 等节点上 Figma 的 componentId，`pruneNode` 保留后可在无 `_componentDesc` 时用 components 映射补全 */
    'componentId',
    /** 图标等 INSTANCE 的变体（如 Size: 16-sm），供 iconfont 按规格匹配 */
    'componentProperties',
    'children',
    'overrides',
    'absoluteBoundingBox',
    'relativeTransform',
    'fills',
    'strokes',
    'strokeWeight',
    /** 各边独立描边宽度；与 strokeWeight 组合用于仅底边等不对称边框 */
    'individualStrokeWeights',
    'strokeAlign',
    'strokeCap',
    'strokeJoin',
    'strokeDashes',
    'effects',
    'cornerRadius',
    'rectangleCornerRadii',
    'cornerSmoothing',
    'layoutMode',
    'layoutAlign',
    'layoutGrow',
    'layoutShrink',
    'layoutWrap',
    'layoutSizingHorizontal',
    'layoutSizingVertical',
    // Figma auto-layout 中的绝对定位子节点（例如顶部 nav/header），必须保留
    'layoutPositioning',
    // 裁剪子内容 → style.overflow（见 style-extractor）
    'clipsContent',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
    'paddingBottom',
    'itemSpacing',
    'constraints',
    'backgroundColor',
    'background',
    'characters',
    'characterStyleOverrides',
    'styleOverrideTable',
    'style',
    'imageRef',
    'opacity',
    'blendMode',
    'primaryAxisAlignItems',
    'primaryAxisAlignContent',
    'primaryAxisSizingMode',
    'counterAxisAlignItems',
    'counterAxisSizingMode',
    // Figma CSS Grid / Grid 子项
    'gridColumnCount',
    'gridRowCount',
    'gridRowGap',
    'gridColumnGap',
    'gridColumnsSizing',
    'gridRowsSizing',
    'gridColumnAnchorIndex',
    'gridRowAnchorIndex',
    'gridColumnSpan',
    'gridRowSpan',
    'gridChildHorizontalAlign',
    'gridChildVerticalAlign',
];
const MIN_RENDERABLE_SIZE = 0.5;
const VECTOR_NODE_TYPES = new Set([
    'VECTOR',
    'ELLIPSE',
    'LINE',
    'POLYGON',
    'STAR',
    'REGULAR_POLYGON',
    'BOOLEAN',
    'BOOLEAN_OPERATION',
    'RECTANGLE',
]);

var id = "5030028";
var name = "shadowBot";
var font_family = "iconfont";
var css_prefix_text = "icon-";
var description = "影刀公共图标库";
var glyphs = [
	{
		icon_id: "47308127",
		name: "Chevron left-Filled",
		font_class: "a-Chevronleft-Filled",
		unicode: "e8f0",
		unicode_decimal: 59632
	},
	{
		icon_id: "46995292",
		name: "Experiment-sm",
		font_class: "Experiment-sm",
		unicode: "e8e9",
		unicode_decimal: 59625
	},
	{
		icon_id: "46995294",
		name: "Experiment-xs",
		font_class: "Experiment-xs",
		unicode: "e8ea",
		unicode_decimal: 59626
	},
	{
		icon_id: "46995289",
		name: "AI03-sm",
		font_class: "AI03-sm",
		unicode: "e8eb",
		unicode_decimal: 59627
	},
	{
		icon_id: "46995290",
		name: "AI03-xs",
		font_class: "AI03-xs",
		unicode: "e8ec",
		unicode_decimal: 59628
	},
	{
		icon_id: "46995288",
		name: "Bot-Filled",
		font_class: "Bot-Filled",
		unicode: "e8ed",
		unicode_decimal: 59629
	},
	{
		icon_id: "46995286",
		name: "AI03-lg",
		font_class: "AI03-lg",
		unicode: "e8ee",
		unicode_decimal: 59630
	},
	{
		icon_id: "46995285",
		name: "AI03-Filled",
		font_class: "AI03-Filled",
		unicode: "e8ef",
		unicode_decimal: 59631
	},
	{
		icon_id: "46995301",
		name: "Palette-lg",
		font_class: "Palette-lg",
		unicode: "e8e1",
		unicode_decimal: 59617
	},
	{
		icon_id: "46995300",
		name: "Lock-Filled",
		font_class: "Lock-Filled",
		unicode: "e8e2",
		unicode_decimal: 59618
	},
	{
		icon_id: "46995299",
		name: "Deepseek-logo",
		font_class: "Deepseek-logo",
		unicode: "e8e3",
		unicode_decimal: 59619
	},
	{
		icon_id: "46995296",
		name: "Experiment-xl",
		font_class: "Experiment-xl",
		unicode: "e8e4",
		unicode_decimal: 59620
	},
	{
		icon_id: "46995297",
		name: "Experiment-lg",
		font_class: "Experiment-lg",
		unicode: "e8e5",
		unicode_decimal: 59621
	},
	{
		icon_id: "46995293",
		name: "Gemini-logo",
		font_class: "Gemini-logo",
		unicode: "e8e6",
		unicode_decimal: 59622
	},
	{
		icon_id: "46995291",
		name: "Apple-logo",
		font_class: "Apple-logo",
		unicode: "e8e7",
		unicode_decimal: 59623
	},
	{
		icon_id: "46995295",
		name: "AI03-xl",
		font_class: "AI03-xl",
		unicode: "e8e8",
		unicode_decimal: 59624
	},
	{
		icon_id: "46995312",
		name: "Shadowbot-logo-lg",
		font_class: "Shadowbot-logo-lg",
		unicode: "e8d8",
		unicode_decimal: 59608
	},
	{
		icon_id: "46995313",
		name: "Shadowbot-logo-sm",
		font_class: "Shadowbot-logo-sm",
		unicode: "e8d9",
		unicode_decimal: 59609
	},
	{
		icon_id: "46995306",
		name: "Image-Filled",
		font_class: "Image-Filled",
		unicode: "e8da",
		unicode_decimal: 59610
	},
	{
		icon_id: "46995308",
		name: "Shadowbot-logo-Filled",
		font_class: "Shadowbot-logo-Filled",
		unicode: "e8db",
		unicode_decimal: 59611
	},
	{
		icon_id: "46995303",
		name: "Palette-xs",
		font_class: "Palette-xs",
		unicode: "e8dc",
		unicode_decimal: 59612
	},
	{
		icon_id: "46995307",
		name: "Sand clock-xl",
		font_class: "a-Sandclock-xl",
		unicode: "e8dd",
		unicode_decimal: 59613
	},
	{
		icon_id: "46995305",
		name: "Sand clock-sm",
		font_class: "a-Sandclock-sm",
		unicode: "e8de",
		unicode_decimal: 59614
	},
	{
		icon_id: "46995287",
		name: "AI03-md",
		font_class: "AI03-md",
		unicode: "e8df",
		unicode_decimal: 59615
	},
	{
		icon_id: "46995298",
		name: "Experiment-md",
		font_class: "Experiment-md",
		unicode: "e8e0",
		unicode_decimal: 59616
	},
	{
		icon_id: "46995317",
		name: "Shadowbot-logo-xl",
		font_class: "Shadowbot-logo-xl",
		unicode: "e8d0",
		unicode_decimal: 59600
	},
	{
		icon_id: "46995319",
		name: "Sand clock-xs",
		font_class: "a-Sandclock-xs",
		unicode: "e8d1",
		unicode_decimal: 59601
	},
	{
		icon_id: "46995304",
		name: "Sand clock-md",
		font_class: "a-Sandclock-md",
		unicode: "e8d2",
		unicode_decimal: 59602
	},
	{
		icon_id: "46995309",
		name: "Sand clock-lg",
		font_class: "a-Sandclock-lg",
		unicode: "e8d3",
		unicode_decimal: 59603
	},
	{
		icon_id: "46995314",
		name: "Palette-sm",
		font_class: "Palette-sm",
		unicode: "e8d4",
		unicode_decimal: 59604
	},
	{
		icon_id: "46995316",
		name: "Palette-xl",
		font_class: "Palette-xl",
		unicode: "e8d5",
		unicode_decimal: 59605
	},
	{
		icon_id: "46995310",
		name: "Github-logo-Filled",
		font_class: "Github-logo-Filled",
		unicode: "e8d6",
		unicode_decimal: 59606
	},
	{
		icon_id: "46995302",
		name: "Palette-Filled",
		font_class: "Palette-Filled",
		unicode: "e8d7",
		unicode_decimal: 59607
	},
	{
		icon_id: "46995321",
		name: "Shadowbot-logo-xs",
		font_class: "Shadowbot-logo-xs",
		unicode: "e8cf",
		unicode_decimal: 59599
	},
	{
		icon_id: "46995324",
		name: "Zhipu-logo",
		font_class: "Zhipu-logo",
		unicode: "e8c8",
		unicode_decimal: 59592
	},
	{
		icon_id: "46995315",
		name: "Moonshot-logo",
		font_class: "Moonshot-logo",
		unicode: "e8c9",
		unicode_decimal: 59593
	},
	{
		icon_id: "46995311",
		name: "Chatgpt-logo",
		font_class: "Chatgpt-logo",
		unicode: "e8ca",
		unicode_decimal: 59594
	},
	{
		icon_id: "46995323",
		name: "Send-Filled",
		font_class: "Send-Filled",
		unicode: "e8cb",
		unicode_decimal: 59595
	},
	{
		icon_id: "46995318",
		name: "Palette-md",
		font_class: "Palette-md",
		unicode: "e8cc",
		unicode_decimal: 59596
	},
	{
		icon_id: "46995322",
		name: "Windows-logo",
		font_class: "Windows-logo",
		unicode: "e8cd",
		unicode_decimal: 59597
	},
	{
		icon_id: "46995320",
		name: "Shadowbot-logo-md",
		font_class: "Shadowbot-logo-md",
		unicode: "e8ce",
		unicode_decimal: 59598
	},
	{
		icon_id: "46995089",
		name: "Brain-Filled",
		font_class: "Brain-Filled",
		unicode: "e8c6",
		unicode_decimal: 59590
	},
	{
		icon_id: "46995090",
		name: "Mic vocal-Filled",
		font_class: "a-Micvocal-Filled",
		unicode: "e8c7",
		unicode_decimal: 59591
	},
	{
		icon_id: "46987999",
		name: "bulb",
		font_class: "bulb",
		unicode: "e609",
		unicode_decimal: 58889
	},
	{
		icon_id: "46977160",
		name: "Brain-sm",
		font_class: "Brain-sm",
		unicode: "e8c0",
		unicode_decimal: 59584
	},
	{
		icon_id: "46977157",
		name: "Brain-xs",
		font_class: "Brain-xs",
		unicode: "e8c1",
		unicode_decimal: 59585
	},
	{
		icon_id: "46977155",
		name: "Mic vocal-md",
		font_class: "a-Micvocal-md",
		unicode: "e8c2",
		unicode_decimal: 59586
	},
	{
		icon_id: "46977158",
		name: "Mic vocal-xs",
		font_class: "a-Micvocal-xs",
		unicode: "e8c3",
		unicode_decimal: 59587
	},
	{
		icon_id: "46977156",
		name: "Brain-md",
		font_class: "Brain-md",
		unicode: "e8c4",
		unicode_decimal: 59588
	},
	{
		icon_id: "46977154",
		name: "Mic vocal-xl",
		font_class: "a-Micvocal-xl",
		unicode: "e8c5",
		unicode_decimal: 59589
	},
	{
		icon_id: "46977162",
		name: "Mic vocal-sm",
		font_class: "a-Micvocal-sm",
		unicode: "e8bc",
		unicode_decimal: 59580
	},
	{
		icon_id: "46977153",
		name: "Mic vocal-lg",
		font_class: "a-Micvocal-lg",
		unicode: "e8bd",
		unicode_decimal: 59581
	},
	{
		icon_id: "46977159",
		name: "Brain-lg",
		font_class: "Brain-lg",
		unicode: "e8be",
		unicode_decimal: 59582
	},
	{
		icon_id: "46977161",
		name: "Brain-xl",
		font_class: "Brain-xl",
		unicode: "e8bf",
		unicode_decimal: 59583
	},
	{
		icon_id: "46973125",
		name: "Icable-xl",
		font_class: "Icable-xl",
		unicode: "e8ba",
		unicode_decimal: 59578
	},
	{
		icon_id: "46973123",
		name: "Icable-lg",
		font_class: "Icable-lg",
		unicode: "e8bb",
		unicode_decimal: 59579
	},
	{
		icon_id: "46973127",
		name: "Icable-md",
		font_class: "Icable-md",
		unicode: "e8b7",
		unicode_decimal: 59575
	},
	{
		icon_id: "46973126",
		name: "Icable-sm",
		font_class: "Icable-sm",
		unicode: "e8b8",
		unicode_decimal: 59576
	},
	{
		icon_id: "46973124",
		name: "Icable-xs",
		font_class: "Icable-xs",
		unicode: "e8b9",
		unicode_decimal: 59577
	},
	{
		icon_id: "46948873",
		name: "Quote right-Filled",
		font_class: "a-Quoteright-Filled",
		unicode: "e8b5",
		unicode_decimal: 59573
	},
	{
		icon_id: "46948872",
		name: "Quote left-Filled",
		font_class: "a-Quoteleft-Filled",
		unicode: "e8b6",
		unicode_decimal: 59574
	},
	{
		icon_id: "46932979",
		name: "Paperclip2-md",
		font_class: "Paperclip2-md",
		unicode: "e8b0",
		unicode_decimal: 59568
	},
	{
		icon_id: "46932977",
		name: "Paperclip2-xl",
		font_class: "Paperclip2-xl",
		unicode: "e8b1",
		unicode_decimal: 59569
	},
	{
		icon_id: "46932978",
		name: "Paperclip2-lg",
		font_class: "Paperclip2-lg",
		unicode: "e8b2",
		unicode_decimal: 59570
	},
	{
		icon_id: "46932976",
		name: "Paperclip2-xs",
		font_class: "Paperclip2-xs",
		unicode: "e8b3",
		unicode_decimal: 59571
	},
	{
		icon_id: "46932975",
		name: "Paperclip2-sm",
		font_class: "Paperclip2-sm",
		unicode: "e8b4",
		unicode_decimal: 59572
	},
	{
		icon_id: "46923403",
		name: "Image-update-xs",
		font_class: "Image-update-xs",
		unicode: "e8aa",
		unicode_decimal: 59562
	},
	{
		icon_id: "46923409",
		name: "Transparent-bg-xl",
		font_class: "Transparent-bg-xl",
		unicode: "e8ab",
		unicode_decimal: 59563
	},
	{
		icon_id: "46923410",
		name: "Transparent-bg-xs",
		font_class: "Transparent-bg-xs",
		unicode: "e8ac",
		unicode_decimal: 59564
	},
	{
		icon_id: "46923408",
		name: "Selection-region-xl",
		font_class: "Selection-region-xl",
		unicode: "e8ad",
		unicode_decimal: 59565
	},
	{
		icon_id: "46923404",
		name: "Selection-region-xs",
		font_class: "Selection-region-xs",
		unicode: "e8ae",
		unicode_decimal: 59566
	},
	{
		icon_id: "46923405",
		name: "Image-upscale-lg",
		font_class: "Image-upscale-lg",
		unicode: "e8af",
		unicode_decimal: 59567
	},
	{
		icon_id: "46923417",
		name: "Image-plus-xl",
		font_class: "Image-plus-xl",
		unicode: "e8a2",
		unicode_decimal: 59554
	},
	{
		icon_id: "46923413",
		name: "Image-plus-xs",
		font_class: "Image-plus-xs",
		unicode: "e8a3",
		unicode_decimal: 59555
	},
	{
		icon_id: "46923414",
		name: "Image-upscale-xl",
		font_class: "Image-upscale-xl",
		unicode: "e8a4",
		unicode_decimal: 59556
	},
	{
		icon_id: "46923407",
		name: "Hand-tool-lg",
		font_class: "Hand-tool-lg",
		unicode: "e8a5",
		unicode_decimal: 59557
	},
	{
		icon_id: "46923412",
		name: "Wand-sparkles-lg",
		font_class: "Wand-sparkles-lg",
		unicode: "e8a6",
		unicode_decimal: 59558
	},
	{
		icon_id: "46923411",
		name: "Image-update-xl",
		font_class: "Image-update-xl",
		unicode: "e8a7",
		unicode_decimal: 59559
	},
	{
		icon_id: "46923402",
		name: "Transparent-bg-lg",
		font_class: "Transparent-bg-lg",
		unicode: "e8a8",
		unicode_decimal: 59560
	},
	{
		icon_id: "46923406",
		name: "Transparent-bg-md",
		font_class: "Transparent-bg-md",
		unicode: "e8a9",
		unicode_decimal: 59561
	},
	{
		icon_id: "46923420",
		name: "Lasso-sm",
		font_class: "Lasso-sm",
		unicode: "e898",
		unicode_decimal: 59544
	},
	{
		icon_id: "46923427",
		name: "Image-plus-lg",
		font_class: "Image-plus-lg",
		unicode: "e899",
		unicode_decimal: 59545
	},
	{
		icon_id: "46923425",
		name: "Selection-region-sm",
		font_class: "Selection-region-sm",
		unicode: "e89a",
		unicode_decimal: 59546
	},
	{
		icon_id: "46923426",
		name: "Hand-tool-sm",
		font_class: "Hand-tool-sm",
		unicode: "e89b",
		unicode_decimal: 59547
	},
	{
		icon_id: "46923422",
		name: "Image-upscale-sm",
		font_class: "Image-upscale-sm",
		unicode: "e89c",
		unicode_decimal: 59548
	},
	{
		icon_id: "46923421",
		name: "Hand-tool-md",
		font_class: "Hand-tool-md",
		unicode: "e89d",
		unicode_decimal: 59549
	},
	{
		icon_id: "46923416",
		name: "Image-upscale-xs",
		font_class: "Image-upscale-xs",
		unicode: "e89e",
		unicode_decimal: 59550
	},
	{
		icon_id: "46923415",
		name: "Lasso-xl",
		font_class: "Lasso-xl",
		unicode: "e89f",
		unicode_decimal: 59551
	},
	{
		icon_id: "46923419",
		name: "Hand-tool-xl",
		font_class: "Hand-tool-xl",
		unicode: "e8a0",
		unicode_decimal: 59552
	},
	{
		icon_id: "46923418",
		name: "Image-update-md",
		font_class: "Image-update-md",
		unicode: "e8a1",
		unicode_decimal: 59553
	},
	{
		icon_id: "46923434",
		name: "Wand-sparkles-md",
		font_class: "Wand-sparkles-md",
		unicode: "e88f",
		unicode_decimal: 59535
	},
	{
		icon_id: "46923432",
		name: "Selection-region-lg",
		font_class: "Selection-region-lg",
		unicode: "e890",
		unicode_decimal: 59536
	},
	{
		icon_id: "46923423",
		name: "Selection-region-md",
		font_class: "Selection-region-md",
		unicode: "e891",
		unicode_decimal: 59537
	},
	{
		icon_id: "46923435",
		name: "Image-plus-md",
		font_class: "Image-plus-md",
		unicode: "e892",
		unicode_decimal: 59538
	},
	{
		icon_id: "46923429",
		name: "Hand-tool-xs",
		font_class: "Hand-tool-xs",
		unicode: "e893",
		unicode_decimal: 59539
	},
	{
		icon_id: "46923424",
		name: "Image-update-lg",
		font_class: "Image-update-lg",
		unicode: "e894",
		unicode_decimal: 59540
	},
	{
		icon_id: "46923430",
		name: "Wand-sparkles-xs",
		font_class: "Wand-sparkles-xs",
		unicode: "e895",
		unicode_decimal: 59541
	},
	{
		icon_id: "46923428",
		name: "Wand-sparkles-xl",
		font_class: "Wand-sparkles-xl",
		unicode: "e896",
		unicode_decimal: 59542
	},
	{
		icon_id: "46923431",
		name: "Lasso-xs",
		font_class: "Lasso-xs",
		unicode: "e897",
		unicode_decimal: 59543
	},
	{
		icon_id: "46923437",
		name: "Transparent-bg-sm",
		font_class: "Transparent-bg-sm",
		unicode: "e888",
		unicode_decimal: 59528
	},
	{
		icon_id: "46923438",
		name: "Lasso-md",
		font_class: "Lasso-md",
		unicode: "e889",
		unicode_decimal: 59529
	},
	{
		icon_id: "46923441",
		name: "Image-update-sm",
		font_class: "Image-update-sm",
		unicode: "e88a",
		unicode_decimal: 59530
	},
	{
		icon_id: "46923436",
		name: "Image-upscale-md",
		font_class: "Image-upscale-md",
		unicode: "e88b",
		unicode_decimal: 59531
	},
	{
		icon_id: "46923440",
		name: "Image-plus-sm",
		font_class: "Image-plus-sm",
		unicode: "e88c",
		unicode_decimal: 59532
	},
	{
		icon_id: "46923439",
		name: "Lasso-lg",
		font_class: "Lasso-lg",
		unicode: "e88d",
		unicode_decimal: 59533
	},
	{
		icon_id: "46923433",
		name: "Wand-sparkles-sm",
		font_class: "Wand-sparkles-sm",
		unicode: "e88e",
		unicode_decimal: 59534
	},
	{
		icon_id: "46862398",
		name: "Tree-sm",
		font_class: "Tree-sm",
		unicode: "e883",
		unicode_decimal: 59523
	},
	{
		icon_id: "46862400",
		name: "Tree-xs",
		font_class: "Tree-xs",
		unicode: "e884",
		unicode_decimal: 59524
	},
	{
		icon_id: "46862401",
		name: "Tree-xl",
		font_class: "Tree-xl",
		unicode: "e885",
		unicode_decimal: 59525
	},
	{
		icon_id: "46862399",
		name: "Tree-lg",
		font_class: "Tree-lg",
		unicode: "e886",
		unicode_decimal: 59526
	},
	{
		icon_id: "46862397",
		name: "Tree-md",
		font_class: "Tree-md",
		unicode: "e887",
		unicode_decimal: 59527
	},
	{
		icon_id: "46834736",
		name: "Error",
		font_class: "Error",
		unicode: "e882",
		unicode_decimal: 59522
	},
	{
		icon_id: "46834744",
		name: "paintbrush-Filled",
		font_class: "paintbrush-Filled",
		unicode: "e879",
		unicode_decimal: 59513
	},
	{
		icon_id: "46834743",
		name: "Warning",
		font_class: "Warning",
		unicode: "e87a",
		unicode_decimal: 59514
	},
	{
		icon_id: "46834742",
		name: "Pie chart-Filled",
		font_class: "a-Piechart-Filled",
		unicode: "e87b",
		unicode_decimal: 59515
	},
	{
		icon_id: "46834739",
		name: "presentation-Filled",
		font_class: "presentation-Filled",
		unicode: "e87c",
		unicode_decimal: 59516
	},
	{
		icon_id: "46834741",
		name: "Help circle",
		font_class: "a-Helpcircle",
		unicode: "e87d",
		unicode_decimal: 59517
	},
	{
		icon_id: "46834738",
		name: "Feather-Filled",
		font_class: "Feather-Filled",
		unicode: "e87e",
		unicode_decimal: 59518
	},
	{
		icon_id: "46834740",
		name: "Tv Play-Filled",
		font_class: "a-TvPlay-Filled",
		unicode: "e87f",
		unicode_decimal: 59519
	},
	{
		icon_id: "46834737",
		name: "Correct",
		font_class: "Correct",
		unicode: "e880",
		unicode_decimal: 59520
	},
	{
		icon_id: "46834735",
		name: "Info",
		font_class: "Info",
		unicode: "e881",
		unicode_decimal: 59521
	},
	{
		icon_id: "46834688",
		name: "Tv Play-sm",
		font_class: "a-TvPlay-sm",
		unicode: "e878",
		unicode_decimal: 59512
	},
	{
		icon_id: "46834692",
		name: "Tv Play-xl",
		font_class: "a-TvPlay-xl",
		unicode: "e874",
		unicode_decimal: 59508
	},
	{
		icon_id: "46834691",
		name: "Tv Play-md",
		font_class: "a-TvPlay-md",
		unicode: "e875",
		unicode_decimal: 59509
	},
	{
		icon_id: "46834690",
		name: "Tv Play-lg",
		font_class: "a-TvPlay-lg",
		unicode: "e876",
		unicode_decimal: 59510
	},
	{
		icon_id: "46834689",
		name: "Tv Play-xs",
		font_class: "a-TvPlay-xs",
		unicode: "e877",
		unicode_decimal: 59511
	},
	{
		icon_id: "46815937",
		name: "R-Sidebar-Filled",
		font_class: "R-Sidebar-Filled",
		unicode: "e872",
		unicode_decimal: 59506
	},
	{
		icon_id: "46815936",
		name: "L-Sidebar-Filled",
		font_class: "L-Sidebar-Filled",
		unicode: "e873",
		unicode_decimal: 59507
	},
	{
		icon_id: "46767045",
		name: "Board-sm",
		font_class: "Board-sm",
		unicode: "efdc",
		unicode_decimal: 61404
	},
	{
		icon_id: "46706783",
		name: "bot-lg",
		font_class: "bot-lg",
		unicode: "e86d",
		unicode_decimal: 59501
	},
	{
		icon_id: "46706784",
		name: "bot-sm",
		font_class: "bot-sm",
		unicode: "e86e",
		unicode_decimal: 59502
	},
	{
		icon_id: "46706785",
		name: "bot-xs",
		font_class: "bot-xs",
		unicode: "e86f",
		unicode_decimal: 59503
	},
	{
		icon_id: "46706786",
		name: "bot-md",
		font_class: "bot-md",
		unicode: "e870",
		unicode_decimal: 59504
	},
	{
		icon_id: "46706787",
		name: "bot-xl",
		font_class: "bot-xl",
		unicode: "e871",
		unicode_decimal: 59505
	},
	{
		icon_id: "46706724",
		name: "scale-xl",
		font_class: "scale-xl",
		unicode: "e867",
		unicode_decimal: 59495
	},
	{
		icon_id: "46706720",
		name: "portrait-sm",
		font_class: "portrait-sm",
		unicode: "e868",
		unicode_decimal: 59496
	},
	{
		icon_id: "46706719",
		name: "presentation-lg",
		font_class: "presentation-lg",
		unicode: "e869",
		unicode_decimal: 59497
	},
	{
		icon_id: "46706717",
		name: "scale-xs",
		font_class: "scale-xs",
		unicode: "e86a",
		unicode_decimal: 59498
	},
	{
		icon_id: "46706716",
		name: "portrait-xl",
		font_class: "portrait-xl",
		unicode: "e86b",
		unicode_decimal: 59499
	},
	{
		icon_id: "46706715",
		name: "portrait-lg",
		font_class: "portrait-lg",
		unicode: "e86c",
		unicode_decimal: 59500
	},
	{
		icon_id: "46706726",
		name: "plane-lg",
		font_class: "plane-lg",
		unicode: "e85d",
		unicode_decimal: 59485
	},
	{
		icon_id: "46706732",
		name: "presentation-sm",
		font_class: "presentation-sm",
		unicode: "e85e",
		unicode_decimal: 59486
	},
	{
		icon_id: "46706731",
		name: "scale-md",
		font_class: "scale-md",
		unicode: "e85f",
		unicode_decimal: 59487
	},
	{
		icon_id: "46706728",
		name: "scale-sm",
		font_class: "scale-sm",
		unicode: "e860",
		unicode_decimal: 59488
	},
	{
		icon_id: "46706727",
		name: "paintbrush-xs",
		font_class: "paintbrush-xs",
		unicode: "e861",
		unicode_decimal: 59489
	},
	{
		icon_id: "46706718",
		name: "presentation-md",
		font_class: "presentation-md",
		unicode: "e862",
		unicode_decimal: 59490
	},
	{
		icon_id: "46706721",
		name: "plane-md",
		font_class: "plane-md",
		unicode: "e863",
		unicode_decimal: 59491
	},
	{
		icon_id: "46706725",
		name: "plane-xs",
		font_class: "plane-xs",
		unicode: "e864",
		unicode_decimal: 59492
	},
	{
		icon_id: "46706722",
		name: "portrait-xs",
		font_class: "portrait-xs",
		unicode: "e865",
		unicode_decimal: 59493
	},
	{
		icon_id: "46706723",
		name: "portrait-md",
		font_class: "portrait-md",
		unicode: "e866",
		unicode_decimal: 59494
	},
	{
		icon_id: "46706739",
		name: "presentation-xs",
		font_class: "presentation-xs",
		unicode: "e854",
		unicode_decimal: 59476
	},
	{
		icon_id: "46706738",
		name: "scale-lg",
		font_class: "scale-lg",
		unicode: "e855",
		unicode_decimal: 59477
	},
	{
		icon_id: "46706733",
		name: "presentation-xl",
		font_class: "presentation-xl",
		unicode: "e856",
		unicode_decimal: 59478
	},
	{
		icon_id: "46706736",
		name: "paintbrush-sm",
		font_class: "paintbrush-sm",
		unicode: "e857",
		unicode_decimal: 59479
	},
	{
		icon_id: "46706737",
		name: "paintbrush-lg",
		font_class: "paintbrush-lg",
		unicode: "e858",
		unicode_decimal: 59480
	},
	{
		icon_id: "46706730",
		name: "plane-sm",
		font_class: "plane-sm",
		unicode: "e859",
		unicode_decimal: 59481
	},
	{
		icon_id: "46706735",
		name: "paintbrush-md",
		font_class: "paintbrush-md",
		unicode: "e85a",
		unicode_decimal: 59482
	},
	{
		icon_id: "46706729",
		name: "plane-xl",
		font_class: "plane-xl",
		unicode: "e85b",
		unicode_decimal: 59483
	},
	{
		icon_id: "46706734",
		name: "paintbrush-xl",
		font_class: "paintbrush-xl",
		unicode: "e85c",
		unicode_decimal: 59484
	},
	{
		icon_id: "46704307",
		name: "Video-md",
		font_class: "Video-md1",
		unicode: "e852",
		unicode_decimal: 59474
	},
	{
		icon_id: "46704308",
		name: "Video-xs",
		font_class: "Video-xs1",
		unicode: "e853",
		unicode_decimal: 59475
	},
	{
		icon_id: "46704311",
		name: "Video-xl",
		font_class: "Video-xl1",
		unicode: "e84f",
		unicode_decimal: 59471
	},
	{
		icon_id: "46704310",
		name: "Video-lg",
		font_class: "Video-lg1",
		unicode: "e850",
		unicode_decimal: 59472
	},
	{
		icon_id: "46704309",
		name: "Video-sm",
		font_class: "Video-sm1",
		unicode: "e851",
		unicode_decimal: 59473
	},
	{
		icon_id: "46704201",
		name: "Folder 2-xl",
		font_class: "a-Folder2-xl",
		unicode: "e84a",
		unicode_decimal: 59466
	},
	{
		icon_id: "46704200",
		name: "Folder 2-xs",
		font_class: "a-Folder2-xs",
		unicode: "e84b",
		unicode_decimal: 59467
	},
	{
		icon_id: "46704199",
		name: "Folder 2-md",
		font_class: "a-Folder2-md",
		unicode: "e84c",
		unicode_decimal: 59468
	},
	{
		icon_id: "46704198",
		name: "Folder 2-sm",
		font_class: "a-Folder2-sm",
		unicode: "e84d",
		unicode_decimal: 59469
	},
	{
		icon_id: "46704197",
		name: "Folder 2-lg",
		font_class: "a-Folder2-lg",
		unicode: "e84e",
		unicode_decimal: 59470
	},
	{
		icon_id: "46704179",
		name: "External link 2-xs",
		font_class: "a-Externallink2-xs",
		unicode: "e845",
		unicode_decimal: 59461
	},
	{
		icon_id: "46704178",
		name: "External link 2-md",
		font_class: "a-Externallink2-md",
		unicode: "e846",
		unicode_decimal: 59462
	},
	{
		icon_id: "46704177",
		name: "External link 2-sm",
		font_class: "a-Externallink2-sm",
		unicode: "e847",
		unicode_decimal: 59463
	},
	{
		icon_id: "46704175",
		name: "External link 2-lg",
		font_class: "a-Externallink2-lg",
		unicode: "e848",
		unicode_decimal: 59464
	},
	{
		icon_id: "46704176",
		name: "External link 2-xl",
		font_class: "a-Externallink2-xl",
		unicode: "e849",
		unicode_decimal: 59465
	},
	{
		icon_id: "46696637",
		name: "Log out-sm",
		font_class: "a-Logout-sm1",
		unicode: "efdb",
		unicode_decimal: 61403
	},
	{
		icon_id: "46691539",
		name: "Square code-sm",
		font_class: "a-Squarecode-sm",
		unicode: "efda",
		unicode_decimal: 61402
	},
	{
		icon_id: "46591159",
		name: "Flag-Filled",
		font_class: "Flag-Filled",
		unicode: "e844",
		unicode_decimal: 59460
	},
	{
		icon_id: "46591162",
		name: "Compass-Filled",
		font_class: "Compass-Filled",
		unicode: "e840",
		unicode_decimal: 59456
	},
	{
		icon_id: "46591161",
		name: "Zap-Filled",
		font_class: "Zap-Filled",
		unicode: "e841",
		unicode_decimal: 59457
	},
	{
		icon_id: "46591158",
		name: "App-Filled",
		font_class: "App-Filled",
		unicode: "e842",
		unicode_decimal: 59458
	},
	{
		icon_id: "46591160",
		name: "Book open-Filled",
		font_class: "a-Bookopen-Filled",
		unicode: "e843",
		unicode_decimal: 59459
	},
	{
		icon_id: "46575915",
		name: "Reply-xs",
		font_class: "Reply-xs",
		unicode: "efd8",
		unicode_decimal: 61400
	},
	{
		icon_id: "46575914",
		name: "Revoke-xs",
		font_class: "Revoke-xs",
		unicode: "efd9",
		unicode_decimal: 61401
	},
	{
		icon_id: "46440056",
		name: "Expand all 2-sm",
		font_class: "a-Expandall2-sm",
		unicode: "efe3",
		unicode_decimal: 61411
	},
	{
		icon_id: "46440055",
		name: "Collapse all 2-sm",
		font_class: "a-Collapseall2-sm",
		unicode: "efe4",
		unicode_decimal: 61412
	},
	{
		icon_id: "46439982",
		name: "Incomplete-md",
		font_class: "Incomplete-md",
		unicode: "efe2",
		unicode_decimal: 61410
	},
	{
		icon_id: "46439819",
		name: "Complete-md",
		font_class: "Complete-md",
		unicode: "efe1",
		unicode_decimal: 61409
	},
	{
		icon_id: "46434926",
		name: "Responsible-sm",
		font_class: "Responsible-sm",
		unicode: "efd7",
		unicode_decimal: 61399
	},
	{
		icon_id: "46434920",
		name: "Quotation-md",
		font_class: "Quotation-md",
		unicode: "efd3",
		unicode_decimal: 61395
	},
	{
		icon_id: "46434918",
		name: "User 2-xs",
		font_class: "a-User2-xs",
		unicode: "efd4",
		unicode_decimal: 61396
	},
	{
		icon_id: "46434919",
		name: "Star-sm",
		font_class: "Star-sm1",
		unicode: "efd5",
		unicode_decimal: 61397
	},
	{
		icon_id: "46434917",
		name: "Heart 2-xs",
		font_class: "a-Heart2-xs",
		unicode: "efd6",
		unicode_decimal: 61398
	},
	{
		icon_id: "46434872",
		name: "Coins-sm",
		font_class: "Coins-sm",
		unicode: "efd0",
		unicode_decimal: 61392
	},
	{
		icon_id: "46434871",
		name: "Handshake-md",
		font_class: "Handshake-md",
		unicode: "efd1",
		unicode_decimal: 61393
	},
	{
		icon_id: "46434870",
		name: "Message warning-sm",
		font_class: "a-Messagewarning-sm",
		unicode: "efd2",
		unicode_decimal: 61394
	},
	{
		icon_id: "46434053",
		name: "Shield check-md",
		font_class: "a-Shieldcheck-md",
		unicode: "efcf",
		unicode_decimal: 61391
	},
	{
		icon_id: "46433608",
		name: "Shield check-sm",
		font_class: "a-Shieldcheck-sm",
		unicode: "efce",
		unicode_decimal: 61390
	},
	{
		icon_id: "46433183",
		name: "Shield check-xs",
		font_class: "a-Shieldcheck-xs",
		unicode: "efcd",
		unicode_decimal: 61389
	},
	{
		icon_id: "46432562",
		name: "Code-xl",
		font_class: "Code-xl1",
		unicode: "e83d",
		unicode_decimal: 59453
	},
	{
		icon_id: "46432563",
		name: "Code-xs",
		font_class: "Code-xs1",
		unicode: "e83e",
		unicode_decimal: 59454
	},
	{
		icon_id: "46432561",
		name: "Code-lg",
		font_class: "Code-lg1",
		unicode: "e83f",
		unicode_decimal: 59455
	},
	{
		icon_id: "46432570",
		name: "Screen Rotation-xs",
		font_class: "a-ScreenRotation-xs",
		unicode: "e836",
		unicode_decimal: 59446
	},
	{
		icon_id: "46432569",
		name: "Code-md",
		font_class: "Code-md1",
		unicode: "e837",
		unicode_decimal: 59447
	},
	{
		icon_id: "46432565",
		name: "Screen Rotation-md",
		font_class: "a-ScreenRotation-md",
		unicode: "e838",
		unicode_decimal: 59448
	},
	{
		icon_id: "46432568",
		name: "Screen Rotation-xl",
		font_class: "a-ScreenRotation-xl",
		unicode: "e839",
		unicode_decimal: 59449
	},
	{
		icon_id: "46432567",
		name: "Screen Rotation-sm",
		font_class: "a-ScreenRotation-sm",
		unicode: "e83a",
		unicode_decimal: 59450
	},
	{
		icon_id: "46432566",
		name: "Code-sm",
		font_class: "Code-sm1",
		unicode: "e83b",
		unicode_decimal: 59451
	},
	{
		icon_id: "46432564",
		name: "Screen Rotation-lg",
		font_class: "a-ScreenRotation-lg",
		unicode: "e83c",
		unicode_decimal: 59452
	},
	{
		icon_id: "46405443",
		name: "Add Message-xl",
		font_class: "a-AddMessage-xl",
		unicode: "e834",
		unicode_decimal: 59444
	},
	{
		icon_id: "46405444",
		name: "Add Message-xs",
		font_class: "a-AddMessage-xs",
		unicode: "e835",
		unicode_decimal: 59445
	},
	{
		icon_id: "46405447",
		name: "Add Message-md",
		font_class: "a-AddMessage-md",
		unicode: "e831",
		unicode_decimal: 59441
	},
	{
		icon_id: "46405446",
		name: "Add Message-lg",
		font_class: "a-AddMessage-lg",
		unicode: "e832",
		unicode_decimal: 59442
	},
	{
		icon_id: "46405445",
		name: "Add Message-sm",
		font_class: "a-AddMessage-sm",
		unicode: "e833",
		unicode_decimal: 59443
	},
	{
		icon_id: "46389216",
		name: "Default color",
		font_class: "a-Defaultcolor",
		unicode: "efcc",
		unicode_decimal: 61388
	},
	{
		icon_id: "46387388",
		name: "Text Import-md",
		font_class: "a-TextImport-md",
		unicode: "e82f",
		unicode_decimal: 59439
	},
	{
		icon_id: "46387387",
		name: "Text Import-sm",
		font_class: "a-TextImport-sm",
		unicode: "e830",
		unicode_decimal: 59440
	},
	{
		icon_id: "46387395",
		name: "Number Import-sm",
		font_class: "a-NumberImport-sm",
		unicode: "e827",
		unicode_decimal: 59431
	},
	{
		icon_id: "46387394",
		name: "Number Import-xl",
		font_class: "a-NumberImport-xl",
		unicode: "e828",
		unicode_decimal: 59432
	},
	{
		icon_id: "46387386",
		name: "Text Import-xl",
		font_class: "a-TextImport-xl",
		unicode: "e829",
		unicode_decimal: 59433
	},
	{
		icon_id: "46387393",
		name: "Text Import-lg",
		font_class: "a-TextImport-lg",
		unicode: "e82a",
		unicode_decimal: 59434
	},
	{
		icon_id: "46387392",
		name: "Number Import-xs",
		font_class: "a-NumberImport-xs",
		unicode: "e82b",
		unicode_decimal: 59435
	},
	{
		icon_id: "46387391",
		name: "Number Import-md",
		font_class: "a-NumberImport-md",
		unicode: "e82c",
		unicode_decimal: 59436
	},
	{
		icon_id: "46387389",
		name: "Text Import-xs",
		font_class: "a-TextImport-xs",
		unicode: "e82d",
		unicode_decimal: 59437
	},
	{
		icon_id: "46387390",
		name: "Number Import-lg",
		font_class: "a-NumberImport-lg",
		unicode: "e82e",
		unicode_decimal: 59438
	},
	{
		icon_id: "46383483",
		name: "RPA-sm",
		font_class: "RPA-sm",
		unicode: "efcb",
		unicode_decimal: 61387
	},
	{
		icon_id: "46370187",
		name: "Book-md",
		font_class: "Book-md1",
		unicode: "e823",
		unicode_decimal: 59427
	},
	{
		icon_id: "46370185",
		name: "Book-sm",
		font_class: "Book-sm1",
		unicode: "e824",
		unicode_decimal: 59428
	},
	{
		icon_id: "46370186",
		name: "Book-lg",
		font_class: "Book-lg1",
		unicode: "e825",
		unicode_decimal: 59429
	},
	{
		icon_id: "46370184",
		name: "Book-xl",
		font_class: "Book-xl1",
		unicode: "e826",
		unicode_decimal: 59430
	},
	{
		icon_id: "46370183",
		name: "Book-xs",
		font_class: "Book-xs1",
		unicode: "e822",
		unicode_decimal: 59426
	},
	{
		icon_id: "46366372",
		name: "Intelligent capture-xl",
		font_class: "a-Intelligentcapture-xl",
		unicode: "e81d",
		unicode_decimal: 59421
	},
	{
		icon_id: "46366371",
		name: "Intelligent capture-md",
		font_class: "a-Intelligentcapture-md",
		unicode: "e81e",
		unicode_decimal: 59422
	},
	{
		icon_id: "46366370",
		name: "Intelligent capture-sm",
		font_class: "a-Intelligentcapture-sm",
		unicode: "e81f",
		unicode_decimal: 59423
	},
	{
		icon_id: "46366369",
		name: "Intelligent capture-xs",
		font_class: "a-Intelligentcapture-xs",
		unicode: "e820",
		unicode_decimal: 59424
	},
	{
		icon_id: "46366368",
		name: "Intelligent capture-lg",
		font_class: "a-Intelligentcapture-lg",
		unicode: "e821",
		unicode_decimal: 59425
	},
	{
		icon_id: "46357716",
		name: "Click_dark",
		font_class: "Click_dark",
		unicode: "e608",
		unicode_decimal: 58888
	},
	{
		icon_id: "46337002",
		name: "Capture Similar Elements",
		font_class: "a-CaptureSimilarElements",
		unicode: "e607",
		unicode_decimal: 58887
	},
	{
		icon_id: "46331697",
		name: "Add backwards-sm-dark",
		font_class: "a-Addbackwards-sm-dark",
		unicode: "efc5",
		unicode_decimal: 61381
	},
	{
		icon_id: "46331696",
		name: "Add downwards-sm-dark",
		font_class: "a-Adddownwards-sm-dark",
		unicode: "efc6",
		unicode_decimal: 61382
	},
	{
		icon_id: "46331695",
		name: "Add forward-sm-dark",
		font_class: "a-Addforward-sm-dark",
		unicode: "efc7",
		unicode_decimal: 61383
	},
	{
		icon_id: "46331693",
		name: "Add up-sm-dark",
		font_class: "a-Addup-sm-dark",
		unicode: "efc8",
		unicode_decimal: 61384
	},
	{
		icon_id: "46331692",
		name: "Delete Column-sm-dark",
		font_class: "a-DeleteColumn-sm-dark",
		unicode: "efc9",
		unicode_decimal: 61385
	},
	{
		icon_id: "46331694",
		name: "Delete row-sm-dark",
		font_class: "a-Deleterow-sm-dark",
		unicode: "efca",
		unicode_decimal: 61386
	},
	{
		icon_id: "46331689",
		name: "Add downwards-sm-light",
		font_class: "a-Adddownwards-sm-light",
		unicode: "efbe",
		unicode_decimal: 61374
	},
	{
		icon_id: "46331685",
		name: "Add up-sm-light",
		font_class: "a-Addup-sm-light",
		unicode: "efbf",
		unicode_decimal: 61375
	},
	{
		icon_id: "46331687",
		name: "Add forward-sm-light",
		font_class: "a-Addforward-sm-light",
		unicode: "efc0",
		unicode_decimal: 61376
	},
	{
		icon_id: "46331686",
		name: "Add backwards-sm-light",
		font_class: "a-Addbackwards-sm-light",
		unicode: "efc1",
		unicode_decimal: 61377
	},
	{
		icon_id: "46331688",
		name: "Delete Column-sm-light",
		font_class: "a-DeleteColumn-sm-light",
		unicode: "efc2",
		unicode_decimal: 61378
	},
	{
		icon_id: "46331684",
		name: "Delete row-sm-light",
		font_class: "a-Deleterow-sm-light",
		unicode: "efc3",
		unicode_decimal: 61379
	},
	{
		icon_id: "46327997",
		name: "Anchor_on_dark",
		font_class: "Anchor_on_dark",
		unicode: "e604",
		unicode_decimal: 58884
	},
	{
		icon_id: "46328020",
		name: "Navigation_on_unselected_dark",
		font_class: "Navigation_on_unselected_dark",
		unicode: "e605",
		unicode_decimal: 58885
	},
	{
		icon_id: "46328021",
		name: "Navigation_on_selected_dark",
		font_class: "Navigation_on_selected_dark",
		unicode: "e606",
		unicode_decimal: 58886
	},
	{
		icon_id: "46323809",
		name: "Daodao expression-sm",
		font_class: "a-Daodaoexpression-sm",
		unicode: "efc4",
		unicode_decimal: 61380
	},
	{
		icon_id: "46322259",
		name: "Merge-sm",
		font_class: "Merge-sm",
		unicode: "efbd",
		unicode_decimal: 61373
	},
	{
		icon_id: "46322187",
		name: "List-indent-decrease-sm",
		font_class: "List-indent-decrease-sm",
		unicode: "efb7",
		unicode_decimal: 61367
	},
	{
		icon_id: "46322185",
		name: "List-indent-increase-sm",
		font_class: "List-indent-increase-sm",
		unicode: "efb8",
		unicode_decimal: 61368
	},
	{
		icon_id: "46322184",
		name: "text-align-justify-sm",
		font_class: "text-align-justify-sm",
		unicode: "efb9",
		unicode_decimal: 61369
	},
	{
		icon_id: "46322182",
		name: "Text-align-center-sm",
		font_class: "Text-align-center-sm",
		unicode: "efba",
		unicode_decimal: 61370
	},
	{
		icon_id: "46322186",
		name: "Text-align-end-sm",
		font_class: "Text-align-end-sm",
		unicode: "efbb",
		unicode_decimal: 61371
	},
	{
		icon_id: "46322183",
		name: "Text-align-start-sm",
		font_class: "Text-align-start-sm",
		unicode: "efbc",
		unicode_decimal: 61372
	},
	{
		icon_id: "46322124",
		name: "Heading 2-sm",
		font_class: "a-Heading2-sm",
		unicode: "efb3",
		unicode_decimal: 61363
	},
	{
		icon_id: "46322123",
		name: "Heading 3-sm",
		font_class: "a-Heading3-sm",
		unicode: "efb4",
		unicode_decimal: 61364
	},
	{
		icon_id: "46322122",
		name: "Heading 4-sm",
		font_class: "a-Heading4-sm",
		unicode: "efb5",
		unicode_decimal: 61365
	},
	{
		icon_id: "46322121",
		name: "Heading 1-sm",
		font_class: "a-Heading1-sm",
		unicode: "efb6",
		unicode_decimal: 61366
	},
	{
		icon_id: "46322056",
		name: "List-ordered-sm",
		font_class: "List-ordered-sm",
		unicode: "efad",
		unicode_decimal: 61357
	},
	{
		icon_id: "46322050",
		name: "Color-sm",
		font_class: "Color-sm",
		unicode: "efae",
		unicode_decimal: 61358
	},
	{
		icon_id: "46322052",
		name: "Code 2-sm",
		font_class: "a-Code2-sm",
		unicode: "efaf",
		unicode_decimal: 61359
	},
	{
		icon_id: "46322049",
		name: "Strikethrough-sm",
		font_class: "Strikethrough-sm",
		unicode: "efb0",
		unicode_decimal: 61360
	},
	{
		icon_id: "46322053",
		name: "Font-sm",
		font_class: "Font-sm",
		unicode: "efb1",
		unicode_decimal: 61361
	},
	{
		icon_id: "46322054",
		name: "Text link-sm",
		font_class: "a-Textlink-sm",
		unicode: "efb2",
		unicode_decimal: 61362
	},
	{
		icon_id: "46322060",
		name: "Unlink-sm",
		font_class: "Unlink-sm",
		unicode: "efa7",
		unicode_decimal: 61351
	},
	{
		icon_id: "46322057",
		name: "Card link-sm",
		font_class: "a-Cardlink-sm",
		unicode: "efa8",
		unicode_decimal: 61352
	},
	{
		icon_id: "46322058",
		name: "Reply-sm",
		font_class: "Reply-sm",
		unicode: "efa9",
		unicode_decimal: 61353
	},
	{
		icon_id: "46322059",
		name: "Quote-sm",
		font_class: "Quote-sm",
		unicode: "efaa",
		unicode_decimal: 61354
	},
	{
		icon_id: "46322051",
		name: "Dividing line-sm",
		font_class: "a-Dividingline-sm",
		unicode: "efab",
		unicode_decimal: 61355
	},
	{
		icon_id: "46322055",
		name: "Highlighted block-sm",
		font_class: "a-Highlightedblock-sm",
		unicode: "efac",
		unicode_decimal: 61356
	},
	{
		icon_id: "46309732",
		name: "Loader-sm",
		font_class: "Loader-sm",
		unicode: "e81c",
		unicode_decimal: 59420
	},
	{
		icon_id: "46309060",
		name: "Capture Element-xs",
		font_class: "a-CaptureElement-xs",
		unicode: "e817",
		unicode_decimal: 59415
	},
	{
		icon_id: "46309058",
		name: "Capture Element-xl",
		font_class: "a-CaptureElement-xl",
		unicode: "e818",
		unicode_decimal: 59416
	},
	{
		icon_id: "46309059",
		name: "Capture Element-sm",
		font_class: "a-CaptureElement-sm",
		unicode: "e819",
		unicode_decimal: 59417
	},
	{
		icon_id: "46309057",
		name: "Capture Element-lg",
		font_class: "a-CaptureElement-lg",
		unicode: "e81a",
		unicode_decimal: 59418
	},
	{
		icon_id: "46309056",
		name: "Capture Element-md",
		font_class: "a-CaptureElement-md",
		unicode: "e81b",
		unicode_decimal: 59419
	},
	{
		icon_id: "46280031",
		name: "IE-Filled",
		font_class: "IE-Filled",
		unicode: "e813",
		unicode_decimal: 59411
	},
	{
		icon_id: "46280027",
		name: "AI Flow-sm",
		font_class: "a-AIFlow-sm",
		unicode: "e814",
		unicode_decimal: 59412
	},
	{
		icon_id: "46280029",
		name: "AI Message-md",
		font_class: "a-AIMessage-md",
		unicode: "e815",
		unicode_decimal: 59413
	},
	{
		icon_id: "46280028",
		name: "AI Message-lg",
		font_class: "a-AIMessage-lg",
		unicode: "e816",
		unicode_decimal: 59414
	},
	{
		icon_id: "46280037",
		name: "AI Flow-xl",
		font_class: "a-AIFlow-xl",
		unicode: "e80b",
		unicode_decimal: 59403
	},
	{
		icon_id: "46280036",
		name: "AI Message-sm",
		font_class: "a-AIMessage-sm",
		unicode: "e80c",
		unicode_decimal: 59404
	},
	{
		icon_id: "46280035",
		name: "AI Flow-xs",
		font_class: "a-AIFlow-xs",
		unicode: "e80d",
		unicode_decimal: 59405
	},
	{
		icon_id: "46280034",
		name: "AI Message-xs",
		font_class: "a-AIMessage-xs",
		unicode: "e80e",
		unicode_decimal: 59406
	},
	{
		icon_id: "46280033",
		name: "AI Message-xl",
		font_class: "a-AIMessage-xl",
		unicode: "e80f",
		unicode_decimal: 59407
	},
	{
		icon_id: "46280032",
		name: "AI01-Filled",
		font_class: "AI01-Filled",
		unicode: "e810",
		unicode_decimal: 59408
	},
	{
		icon_id: "46280030",
		name: "AI Flow-lg",
		font_class: "a-AIFlow-lg",
		unicode: "e811",
		unicode_decimal: 59409
	},
	{
		icon_id: "46280026",
		name: "AI Flow-md",
		font_class: "a-AIFlow-md",
		unicode: "e812",
		unicode_decimal: 59410
	},
	{
		icon_id: "46263878",
		name: "Start Run-lg",
		font_class: "a-StartRun-lg",
		unicode: "e806",
		unicode_decimal: 59398
	},
	{
		icon_id: "46263879",
		name: "Start Run-xs",
		font_class: "a-StartRun-xs",
		unicode: "e807",
		unicode_decimal: 59399
	},
	{
		icon_id: "46263877",
		name: "Start Run-md",
		font_class: "a-StartRun-md",
		unicode: "e808",
		unicode_decimal: 59400
	},
	{
		icon_id: "46263875",
		name: "Start Run-xl",
		font_class: "a-StartRun-xl",
		unicode: "e809",
		unicode_decimal: 59401
	},
	{
		icon_id: "46263876",
		name: "Start Run-sm",
		font_class: "a-StartRun-sm",
		unicode: "e80a",
		unicode_decimal: 59402
	},
	{
		icon_id: "46228085",
		name: "Mouse Wheel-md",
		font_class: "a-MouseWheel-md",
		unicode: "e804",
		unicode_decimal: 59396
	},
	{
		icon_id: "46228079",
		name: "Close Window-xs",
		font_class: "a-CloseWindow-xs",
		unicode: "e805",
		unicode_decimal: 59397
	},
	{
		icon_id: "46228086",
		name: "Mouse Click-sm",
		font_class: "a-MouseClick-sm",
		unicode: "e7fd",
		unicode_decimal: 59389
	},
	{
		icon_id: "46228077",
		name: "Double-click-xl",
		font_class: "Double-click-xl",
		unicode: "e7fe",
		unicode_decimal: 59390
	},
	{
		icon_id: "46228084",
		name: "Double-click-sm",
		font_class: "Double-click-sm",
		unicode: "e7ff",
		unicode_decimal: 59391
	},
	{
		icon_id: "46228075",
		name: "Close Window-md",
		font_class: "a-CloseWindow-md",
		unicode: "e800",
		unicode_decimal: 59392
	},
	{
		icon_id: "46228080",
		name: "Double-click-lg",
		font_class: "Double-click-lg",
		unicode: "e801",
		unicode_decimal: 59393
	},
	{
		icon_id: "46228089",
		name: "Mouse Wheel-sm",
		font_class: "a-MouseWheel-sm",
		unicode: "e802",
		unicode_decimal: 59394
	},
	{
		icon_id: "46228078",
		name: "Double-click-xs",
		font_class: "Double-click-xs",
		unicode: "e803",
		unicode_decimal: 59395
	},
	{
		icon_id: "46228095",
		name: "Obtain Text-md",
		font_class: "a-ObtainText-md",
		unicode: "e7f2",
		unicode_decimal: 59378
	},
	{
		icon_id: "46228100",
		name: "Obtain Text-lg",
		font_class: "a-ObtainText-lg",
		unicode: "e7f3",
		unicode_decimal: 59379
	},
	{
		icon_id: "46228081",
		name: "Close Window-xl",
		font_class: "a-CloseWindow-xl",
		unicode: "e7f4",
		unicode_decimal: 59380
	},
	{
		icon_id: "46228098",
		name: "Window-xl",
		font_class: "Window-xl",
		unicode: "e7f5",
		unicode_decimal: 59381
	},
	{
		icon_id: "46228092",
		name: "Window-xs",
		font_class: "Window-xs",
		unicode: "e7f6",
		unicode_decimal: 59382
	},
	{
		icon_id: "46228083",
		name: "Double-click-md",
		font_class: "Double-click-md",
		unicode: "e7f7",
		unicode_decimal: 59383
	},
	{
		icon_id: "46228097",
		name: "Obtain Text-xs",
		font_class: "a-ObtainText-xs",
		unicode: "e7f8",
		unicode_decimal: 59384
	},
	{
		icon_id: "46228087",
		name: "Window-lg",
		font_class: "Window-lg",
		unicode: "e7f9",
		unicode_decimal: 59385
	},
	{
		icon_id: "46228093",
		name: "Mouse Wheel-lg",
		font_class: "a-MouseWheel-lg",
		unicode: "e7fa",
		unicode_decimal: 59386
	},
	{
		icon_id: "46228090",
		name: "Window-sm",
		font_class: "Window-sm",
		unicode: "e7fb",
		unicode_decimal: 59387
	},
	{
		icon_id: "46228091",
		name: "Mouse Click-xl",
		font_class: "a-MouseClick-xl",
		unicode: "e7fc",
		unicode_decimal: 59388
	},
	{
		icon_id: "46228103",
		name: "Window-md",
		font_class: "Window-md",
		unicode: "e7e8",
		unicode_decimal: 59368
	},
	{
		icon_id: "46228101",
		name: "Mouse Click-lg",
		font_class: "a-MouseClick-lg",
		unicode: "e7e9",
		unicode_decimal: 59369
	},
	{
		icon_id: "46228105",
		name: "Mouse Wheel-xl",
		font_class: "a-MouseWheel-xl",
		unicode: "e7ea",
		unicode_decimal: 59370
	},
	{
		icon_id: "46228104",
		name: "Obtain Text-sm",
		font_class: "a-ObtainText-sm",
		unicode: "e7eb",
		unicode_decimal: 59371
	},
	{
		icon_id: "46228099",
		name: "Mouse Click-xs",
		font_class: "a-MouseClick-xs",
		unicode: "e7ec",
		unicode_decimal: 59372
	},
	{
		icon_id: "46228076",
		name: "Close Window-lg",
		font_class: "a-CloseWindow-lg",
		unicode: "e7ed",
		unicode_decimal: 59373
	},
	{
		icon_id: "46228102",
		name: "Obtain Text-xl",
		font_class: "a-ObtainText-xl",
		unicode: "e7ee",
		unicode_decimal: 59374
	},
	{
		icon_id: "46228082",
		name: "Close Window-sm",
		font_class: "a-CloseWindow-sm",
		unicode: "e7ef",
		unicode_decimal: 59375
	},
	{
		icon_id: "46228096",
		name: "Mouse Click-md",
		font_class: "a-MouseClick-md",
		unicode: "e7f0",
		unicode_decimal: 59376
	},
	{
		icon_id: "46228094",
		name: "Mouse Wheel-xs",
		font_class: "a-MouseWheel-xs",
		unicode: "e7f1",
		unicode_decimal: 59377
	},
	{
		icon_id: "46226248",
		name: "Finger-Filled",
		font_class: "Finger-Filled",
		unicode: "e7e7",
		unicode_decimal: 59367
	},
	{
		icon_id: "46226157",
		name: "Thumbs up-Filled",
		font_class: "a-Thumbsup-Filled",
		unicode: "e7e5",
		unicode_decimal: 59365
	},
	{
		icon_id: "46226156",
		name: "Thumbs down-Filled",
		font_class: "a-Thumbsdown-Filled",
		unicode: "e7e6",
		unicode_decimal: 59366
	},
	{
		icon_id: "46158206",
		name: "Play-Filled",
		font_class: "Play-Filled",
		unicode: "e7e3",
		unicode_decimal: 59363
	},
	{
		icon_id: "46158205",
		name: "Pause-Filled",
		font_class: "Pause-Filled",
		unicode: "e7e4",
		unicode_decimal: 59364
	},
	{
		icon_id: "46142745",
		name: "Drag Window-sm",
		font_class: "a-DragWindow-sm",
		unicode: "e7d1",
		unicode_decimal: 59345
	},
	{
		icon_id: "46142743",
		name: "Drag Window-xl",
		font_class: "a-DragWindow-xl",
		unicode: "e7d2",
		unicode_decimal: 59346
	},
	{
		icon_id: "46142744",
		name: "Drag Window-xs",
		font_class: "a-DragWindow-xs",
		unicode: "e7db",
		unicode_decimal: 59355
	},
	{
		icon_id: "46142742",
		name: "Drag Window-md",
		font_class: "a-DragWindow-md",
		unicode: "e7de",
		unicode_decimal: 59358
	},
	{
		icon_id: "46142741",
		name: "Drag Window-lg",
		font_class: "a-DragWindow-lg",
		unicode: "e7df",
		unicode_decimal: 59359
	},
	{
		icon_id: "46142513",
		name: "Finger-lg",
		font_class: "Finger-lg",
		unicode: "e7e1",
		unicode_decimal: 59361
	},
	{
		icon_id: "46142503",
		name: "Capture Similarity-xl",
		font_class: "a-CaptureSimilarity-xl",
		unicode: "e7e2",
		unicode_decimal: 59362
	},
	{
		icon_id: "46142505",
		name: "Location-xs",
		font_class: "Location-xs",
		unicode: "e7dd",
		unicode_decimal: 59357
	},
	{
		icon_id: "46142497",
		name: "Capture Similarity-xs",
		font_class: "a-CaptureSimilarity-xs",
		unicode: "e7e0",
		unicode_decimal: 59360
	},
	{
		icon_id: "46142514",
		name: "Finger-xs",
		font_class: "Finger-xs",
		unicode: "e7d4",
		unicode_decimal: 59348
	},
	{
		icon_id: "46142501",
		name: "Capture Similarity-sm",
		font_class: "a-CaptureSimilarity-sm",
		unicode: "e7d5",
		unicode_decimal: 59349
	},
	{
		icon_id: "46142512",
		name: "Finger-sm",
		font_class: "Finger-sm",
		unicode: "e7d6",
		unicode_decimal: 59350
	},
	{
		icon_id: "46142510",
		name: "Location-lg",
		font_class: "Location-lg",
		unicode: "e7d7",
		unicode_decimal: 59351
	},
	{
		icon_id: "46142511",
		name: "Finger-md",
		font_class: "Finger-md",
		unicode: "e7d8",
		unicode_decimal: 59352
	},
	{
		icon_id: "46142508",
		name: "Capture Similarity-lg",
		font_class: "a-CaptureSimilarity-lg",
		unicode: "e7d9",
		unicode_decimal: 59353
	},
	{
		icon_id: "46142509",
		name: "Location-sm",
		font_class: "Location-sm",
		unicode: "e7da",
		unicode_decimal: 59354
	},
	{
		icon_id: "46142507",
		name: "Location-md",
		font_class: "Location-md",
		unicode: "e7dc",
		unicode_decimal: 59356
	},
	{
		icon_id: "46142516",
		name: "Finger-xl",
		font_class: "Finger-xl",
		unicode: "e7cf",
		unicode_decimal: 59343
	},
	{
		icon_id: "46142515",
		name: "Location-xl",
		font_class: "Location-xl",
		unicode: "e7d0",
		unicode_decimal: 59344
	},
	{
		icon_id: "46142500",
		name: "Capture Similarity-md",
		font_class: "a-CaptureSimilarity-md",
		unicode: "e7d3",
		unicode_decimal: 59347
	},
	{
		icon_id: "46129698",
		name: "Sun Moon-lg",
		font_class: "a-SunMoon-lg",
		unicode: "e7ce",
		unicode_decimal: 59342
	},
	{
		icon_id: "46129701",
		name: "Sun Moon-xl",
		font_class: "a-SunMoon-xl",
		unicode: "e7ca",
		unicode_decimal: 59338
	},
	{
		icon_id: "46129700",
		name: "Sun Moon-sm",
		font_class: "a-SunMoon-sm",
		unicode: "e7cb",
		unicode_decimal: 59339
	},
	{
		icon_id: "46129699",
		name: "Sun Moon-xs",
		font_class: "a-SunMoon-xs",
		unicode: "e7cc",
		unicode_decimal: 59340
	},
	{
		icon_id: "46129697",
		name: "Sun Moon-md",
		font_class: "a-SunMoon-md",
		unicode: "e7cd",
		unicode_decimal: 59341
	},
	{
		icon_id: "46124980",
		name: "Navigation_on_selected",
		font_class: "Navigation_on_selected",
		unicode: "e601",
		unicode_decimal: 58881
	},
	{
		icon_id: "46125006",
		name: "Navigation_on_unselected",
		font_class: "Navigation_on_unselected",
		unicode: "e603",
		unicode_decimal: 58883
	},
	{
		icon_id: "46125000",
		name: "Anchor_on",
		font_class: "Anchor_on",
		unicode: "e602",
		unicode_decimal: 58882
	},
	{
		icon_id: "46123383",
		name: "File Import-xl",
		font_class: "a-FileImport-xl",
		unicode: "e7c4",
		unicode_decimal: 59332
	},
	{
		icon_id: "46123382",
		name: "File Import-sm",
		font_class: "a-FileImport-sm",
		unicode: "e7c5",
		unicode_decimal: 59333
	},
	{
		icon_id: "46123380",
		name: "File Export-sm",
		font_class: "a-FileExport-sm",
		unicode: "e7c6",
		unicode_decimal: 59334
	},
	{
		icon_id: "46123378",
		name: "File Export-xl",
		font_class: "a-FileExport-xl",
		unicode: "e7c7",
		unicode_decimal: 59335
	},
	{
		icon_id: "46123379",
		name: "File Import-lg",
		font_class: "a-FileImport-lg",
		unicode: "e7c8",
		unicode_decimal: 59336
	},
	{
		icon_id: "46123377",
		name: "File Export-lg",
		font_class: "a-FileExport-lg",
		unicode: "e7c9",
		unicode_decimal: 59337
	},
	{
		icon_id: "46123386",
		name: "File Import-xs",
		font_class: "a-FileImport-xs",
		unicode: "e7c0",
		unicode_decimal: 59328
	},
	{
		icon_id: "46123385",
		name: "File Export-md",
		font_class: "a-FileExport-md",
		unicode: "e7c1",
		unicode_decimal: 59329
	},
	{
		icon_id: "46123381",
		name: "File Export-xs",
		font_class: "a-FileExport-xs",
		unicode: "e7c2",
		unicode_decimal: 59330
	},
	{
		icon_id: "46123384",
		name: "File Import-md",
		font_class: "a-FileImport-md",
		unicode: "e7c3",
		unicode_decimal: 59331
	},
	{
		icon_id: "46028833",
		name: "No Nail-sm",
		font_class: "a-NoNail-sm",
		unicode: "e7bb",
		unicode_decimal: 59323
	},
	{
		icon_id: "46028832",
		name: "No Nail-xs",
		font_class: "a-NoNail-xs",
		unicode: "e7bc",
		unicode_decimal: 59324
	},
	{
		icon_id: "46028830",
		name: "No Nail-md",
		font_class: "a-NoNail-md",
		unicode: "e7bd",
		unicode_decimal: 59325
	},
	{
		icon_id: "46028831",
		name: "No Nail-xl",
		font_class: "a-NoNail-xl",
		unicode: "e7be",
		unicode_decimal: 59326
	},
	{
		icon_id: "46028829",
		name: "No Nail-lg",
		font_class: "a-NoNail-lg",
		unicode: "e7bf",
		unicode_decimal: 59327
	},
	{
		icon_id: "45920260",
		name: "AI-Filled",
		font_class: "AI-Filled",
		unicode: "e7ba",
		unicode_decimal: 59322
	},
	{
		icon_id: "45910558",
		name: "Message square-xl",
		font_class: "a-Messagesquare-xl",
		unicode: "e7b6",
		unicode_decimal: 59318
	},
	{
		icon_id: "45910556",
		name: "Message square-md",
		font_class: "a-Messagesquare-md",
		unicode: "e7b7",
		unicode_decimal: 59319
	},
	{
		icon_id: "45910557",
		name: "Message square-sm",
		font_class: "a-Messagesquare-sm",
		unicode: "e7b8",
		unicode_decimal: 59320
	},
	{
		icon_id: "45910555",
		name: "Message square-xs",
		font_class: "a-Messagesquare-xs",
		unicode: "e7b9",
		unicode_decimal: 59321
	},
	{
		icon_id: "45910559",
		name: "Message square-lg",
		font_class: "a-Messagesquare-lg",
		unicode: "e7b5",
		unicode_decimal: 59317
	},
	{
		icon_id: "45895172",
		name: "Phython-colour",
		font_class: "Phython-colour",
		unicode: "e7b4",
		unicode_decimal: 59316
	},
	{
		icon_id: "45772381",
		name: "Maximize-win-lg",
		font_class: "Maximize-lg1",
		unicode: "e7aa",
		unicode_decimal: 59306
	},
	{
		icon_id: "45772376",
		name: "Minimize-win-xl",
		font_class: "Minimize-xl1",
		unicode: "e7ab",
		unicode_decimal: 59307
	},
	{
		icon_id: "45772377",
		name: "Restore-win-md",
		font_class: "Restore-md",
		unicode: "e7ac",
		unicode_decimal: 59308
	},
	{
		icon_id: "45772372",
		name: "Chevron up-xs",
		font_class: "a-Chevronup-sx",
		unicode: "e7ad",
		unicode_decimal: 59309
	},
	{
		icon_id: "45772383",
		name: "Restore-win-xs",
		font_class: "Restore-sx",
		unicode: "e7ae",
		unicode_decimal: 59310
	},
	{
		icon_id: "45772374",
		name: "Maximize-win-md",
		font_class: "Maximize-md1",
		unicode: "e7af",
		unicode_decimal: 59311
	},
	{
		icon_id: "45772375",
		name: "Minimize-win-md",
		font_class: "Minimize-md1",
		unicode: "e7b0",
		unicode_decimal: 59312
	},
	{
		icon_id: "45772380",
		name: "Restore-win-sm",
		font_class: "Restore-sm",
		unicode: "e7b1",
		unicode_decimal: 59313
	},
	{
		icon_id: "45772373",
		name: "Maximize-win-xl",
		font_class: "Maximize-xl1",
		unicode: "e7b2",
		unicode_decimal: 59314
	},
	{
		icon_id: "45772371",
		name: "Chevron up-lg",
		font_class: "a-Chevronup-lg",
		unicode: "e7b3",
		unicode_decimal: 59315
	},
	{
		icon_id: "45772385",
		name: "Chevron up-sm",
		font_class: "a-Chevronup-sm",
		unicode: "e7a0",
		unicode_decimal: 59296
	},
	{
		icon_id: "45772390",
		name: "Minimize-win-xs",
		font_class: "Minimize-sx",
		unicode: "e7a2",
		unicode_decimal: 59298
	},
	{
		icon_id: "45772382",
		name: "Restore-win-xl",
		font_class: "Restore-xl",
		unicode: "e7a3",
		unicode_decimal: 59299
	},
	{
		icon_id: "45772387",
		name: "Chevron up-md",
		font_class: "a-Chevronup-md",
		unicode: "e7a4",
		unicode_decimal: 59300
	},
	{
		icon_id: "45772389",
		name: "Chevron up-xl",
		font_class: "a-Chevronup-xl",
		unicode: "e7a5",
		unicode_decimal: 59301
	},
	{
		icon_id: "45772379",
		name: "Minimize-win-sm",
		font_class: "Minimize-sm1",
		unicode: "e7a6",
		unicode_decimal: 59302
	},
	{
		icon_id: "45772378",
		name: "Minimize-win-lg",
		font_class: "Minimize-lg1",
		unicode: "e7a7",
		unicode_decimal: 59303
	},
	{
		icon_id: "45772388",
		name: "Maximize-win-sm",
		font_class: "Maximize-sm1",
		unicode: "e7a8",
		unicode_decimal: 59304
	},
	{
		icon_id: "45772384",
		name: "Maximize-win-xs",
		font_class: "Maximize-sx",
		unicode: "e7a9",
		unicode_decimal: 59305
	},
	{
		icon_id: "45772386",
		name: "Restore-win-lg",
		font_class: "Restore-lg",
		unicode: "e7a1",
		unicode_decimal: 59297
	},
	{
		icon_id: "45681762",
		name: "Instagram-xs",
		font_class: "Instagram-xs",
		unicode: "ef9d",
		unicode_decimal: 61341
	},
	{
		icon_id: "45681761",
		name: "Instagram-xl",
		font_class: "Instagram-xl",
		unicode: "ef9e",
		unicode_decimal: 61342
	},
	{
		icon_id: "45681760",
		name: "Instagram-sm",
		font_class: "Instagram-sm",
		unicode: "ef9f",
		unicode_decimal: 61343
	},
	{
		icon_id: "45681759",
		name: "Instagram-md",
		font_class: "Instagram-md",
		unicode: "efa0",
		unicode_decimal: 61344
	},
	{
		icon_id: "45681758",
		name: "Instagram-lg",
		font_class: "Instagram-lg",
		unicode: "efa1",
		unicode_decimal: 61345
	},
	{
		icon_id: "45682284",
		name: "Shield off-xs",
		font_class: "a-Shieldoff-xs",
		unicode: "efa2",
		unicode_decimal: 61346
	},
	{
		icon_id: "45682283",
		name: "Shield off-xl",
		font_class: "a-Shieldoff-xl",
		unicode: "efa3",
		unicode_decimal: 61347
	},
	{
		icon_id: "45682282",
		name: "Shield off-sm",
		font_class: "a-Shieldoff-sm",
		unicode: "efa4",
		unicode_decimal: 61348
	},
	{
		icon_id: "45682281",
		name: "Shield off-md",
		font_class: "a-Shieldoff-md",
		unicode: "efa5",
		unicode_decimal: 61349
	},
	{
		icon_id: "45682280",
		name: "Shield off-lg",
		font_class: "a-Shieldoff-lg",
		unicode: "efa6",
		unicode_decimal: 61350
	},
	{
		icon_id: "45682735",
		name: "Bulb-sm",
		font_class: "Bulb-sm",
		unicode: "ef99",
		unicode_decimal: 61337
	},
	{
		icon_id: "45682734",
		name: "Bulb-md",
		font_class: "Bulb-md",
		unicode: "ef9a",
		unicode_decimal: 61338
	},
	{
		icon_id: "45682733",
		name: "Bulb-lg",
		font_class: "Bulb-lg",
		unicode: "ef9b",
		unicode_decimal: 61339
	},
	{
		icon_id: "45682723",
		name: "Zoom out-xs",
		font_class: "a-Zoomout-xs",
		unicode: "ef9c",
		unicode_decimal: 61340
	},
	{
		icon_id: "45682737",
		name: "Bulb-xs",
		font_class: "Bulb-xs",
		unicode: "ef97",
		unicode_decimal: 61335
	},
	{
		icon_id: "45682736",
		name: "Bulb-xl",
		font_class: "Bulb-xl",
		unicode: "ef98",
		unicode_decimal: 61336
	},
	{
		icon_id: "45682720",
		name: "Zoom out-md",
		font_class: "a-Zoomout-md",
		unicode: "ef8f",
		unicode_decimal: 61327
	},
	{
		icon_id: "45682719",
		name: "Zoom out-lg",
		font_class: "a-Zoomout-lg",
		unicode: "ef90",
		unicode_decimal: 61328
	},
	{
		icon_id: "45682718",
		name: "Zoom in-xs",
		font_class: "a-Zoomin-xs",
		unicode: "ef91",
		unicode_decimal: 61329
	},
	{
		icon_id: "45682717",
		name: "Zoom in-xl",
		font_class: "a-Zoomin-xl",
		unicode: "ef92",
		unicode_decimal: 61330
	},
	{
		icon_id: "45682716",
		name: "Zoom in-sm",
		font_class: "a-Zoomin-sm",
		unicode: "ef93",
		unicode_decimal: 61331
	},
	{
		icon_id: "45682715",
		name: "Zoom in-md",
		font_class: "a-Zoomin-md",
		unicode: "ef94",
		unicode_decimal: 61332
	},
	{
		icon_id: "45682714",
		name: "Zoom in-lg",
		font_class: "a-Zoomin-lg",
		unicode: "ef95",
		unicode_decimal: 61333
	},
	{
		icon_id: "45682713",
		name: "Zap off-xs",
		font_class: "a-Zapoff-xs",
		unicode: "ef96",
		unicode_decimal: 61334
	},
	{
		icon_id: "45682722",
		name: "Zoom out-xl",
		font_class: "a-Zoomout-xl",
		unicode: "ef8d",
		unicode_decimal: 61325
	},
	{
		icon_id: "45682721",
		name: "Zoom out-sm",
		font_class: "a-Zoomout-sm",
		unicode: "ef8e",
		unicode_decimal: 61326
	},
	{
		icon_id: "45682699",
		name: "Zap-lg",
		font_class: "Zap-lg",
		unicode: "ef8a",
		unicode_decimal: 61322
	},
	{
		icon_id: "45682698",
		name: "Youtube-xs",
		font_class: "Youtube-xs",
		unicode: "ef8b",
		unicode_decimal: 61323
	},
	{
		icon_id: "45682697",
		name: "Youtube-xl",
		font_class: "Youtube-xl",
		unicode: "ef8c",
		unicode_decimal: 61324
	},
	{
		icon_id: "45682708",
		name: "Zap-xs",
		font_class: "Zap-xs",
		unicode: "ef86",
		unicode_decimal: 61318
	},
	{
		icon_id: "45682703",
		name: "Zap-xl",
		font_class: "Zap-xl",
		unicode: "ef87",
		unicode_decimal: 61319
	},
	{
		icon_id: "45682701",
		name: "Zap-sm",
		font_class: "Zap-sm",
		unicode: "ef88",
		unicode_decimal: 61320
	},
	{
		icon_id: "45682700",
		name: "Zap-md",
		font_class: "Zap-md",
		unicode: "ef89",
		unicode_decimal: 61321
	},
	{
		icon_id: "45682712",
		name: "Zap off-xl",
		font_class: "a-Zapoff-xl",
		unicode: "ef82",
		unicode_decimal: 61314
	},
	{
		icon_id: "45682711",
		name: "Zap off-sm",
		font_class: "a-Zapoff-sm",
		unicode: "ef83",
		unicode_decimal: 61315
	},
	{
		icon_id: "45682710",
		name: "Zap off-md",
		font_class: "a-Zapoff-md",
		unicode: "ef84",
		unicode_decimal: 61316
	},
	{
		icon_id: "45682709",
		name: "Zap off-lg",
		font_class: "a-Zapoff-lg",
		unicode: "ef85",
		unicode_decimal: 61317
	},
	{
		icon_id: "45682693",
		name: "X square-xs",
		font_class: "a-Xsquare-xs",
		unicode: "ef7a",
		unicode_decimal: 61306
	},
	{
		icon_id: "45682692",
		name: "X square-xl",
		font_class: "a-Xsquare-xl",
		unicode: "ef7b",
		unicode_decimal: 61307
	},
	{
		icon_id: "45682691",
		name: "X square-sm",
		font_class: "a-Xsquare-sm",
		unicode: "ef7c",
		unicode_decimal: 61308
	},
	{
		icon_id: "45682690",
		name: "X square-md",
		font_class: "a-Xsquare-md",
		unicode: "ef7d",
		unicode_decimal: 61309
	},
	{
		icon_id: "45682689",
		name: "X square-lg",
		font_class: "a-Xsquare-lg",
		unicode: "ef7e",
		unicode_decimal: 61310
	},
	{
		icon_id: "45682688",
		name: "X octagon-xs",
		font_class: "a-Xoctagon-xs",
		unicode: "ef7f",
		unicode_decimal: 61311
	},
	{
		icon_id: "45682687",
		name: "X octagon-xl",
		font_class: "a-Xoctagon-xl",
		unicode: "ef80",
		unicode_decimal: 61312
	},
	{
		icon_id: "45682686",
		name: "X octagon-sm",
		font_class: "a-Xoctagon-sm",
		unicode: "ef81",
		unicode_decimal: 61313
	},
	{
		icon_id: "45682696",
		name: "Youtube-sm",
		font_class: "Youtube-sm",
		unicode: "ef77",
		unicode_decimal: 61303
	},
	{
		icon_id: "45682695",
		name: "Youtube-md",
		font_class: "Youtube-md",
		unicode: "ef78",
		unicode_decimal: 61304
	},
	{
		icon_id: "45682694",
		name: "Youtube-lg",
		font_class: "Youtube-lg",
		unicode: "ef79",
		unicode_decimal: 61305
	},
	{
		icon_id: "45682681",
		name: "X circle-sm",
		font_class: "a-Xcircle-sm",
		unicode: "ef70",
		unicode_decimal: 61296
	},
	{
		icon_id: "45682680",
		name: "X circle-md",
		font_class: "a-Xcircle-md",
		unicode: "ef71",
		unicode_decimal: 61297
	},
	{
		icon_id: "45682679",
		name: "X circle-lg",
		font_class: "a-Xcircle-lg",
		unicode: "ef72",
		unicode_decimal: 61298
	},
	{
		icon_id: "45682678",
		name: "X-xs",
		font_class: "X-xs",
		unicode: "ef73",
		unicode_decimal: 61299
	},
	{
		icon_id: "45682677",
		name: "X-xl",
		font_class: "X-xl",
		unicode: "ef74",
		unicode_decimal: 61300
	},
	{
		icon_id: "45682676",
		name: "X-sm",
		font_class: "X-sm",
		unicode: "ef75",
		unicode_decimal: 61301
	},
	{
		icon_id: "45682675",
		name: "X-md",
		font_class: "X-md",
		unicode: "ef76",
		unicode_decimal: 61302
	},
	{
		icon_id: "45682685",
		name: "X octagon-md",
		font_class: "a-Xoctagon-md",
		unicode: "ef6c",
		unicode_decimal: 61292
	},
	{
		icon_id: "45682684",
		name: "X octagon-lg",
		font_class: "a-Xoctagon-lg",
		unicode: "ef6d",
		unicode_decimal: 61293
	},
	{
		icon_id: "45682683",
		name: "X circle-xs",
		font_class: "a-Xcircle-xs",
		unicode: "ef6e",
		unicode_decimal: 61294
	},
	{
		icon_id: "45682682",
		name: "X circle-xl",
		font_class: "a-Xcircle-xl",
		unicode: "ef6f",
		unicode_decimal: 61295
	},
	{
		icon_id: "45682671",
		name: "Wind-sm",
		font_class: "Wind-sm",
		unicode: "ef64",
		unicode_decimal: 61284
	},
	{
		icon_id: "45682670",
		name: "Wind-md",
		font_class: "Wind-md",
		unicode: "ef65",
		unicode_decimal: 61285
	},
	{
		icon_id: "45682669",
		name: "Wind-lg",
		font_class: "Wind-lg",
		unicode: "ef66",
		unicode_decimal: 61286
	},
	{
		icon_id: "45682668",
		name: "Wifi off-xs",
		font_class: "a-Wifioff-xs",
		unicode: "ef67",
		unicode_decimal: 61287
	},
	{
		icon_id: "45682667",
		name: "Wifi off-xl",
		font_class: "a-Wifioff-xl",
		unicode: "ef68",
		unicode_decimal: 61288
	},
	{
		icon_id: "45682666",
		name: "Wifi off-sm",
		font_class: "a-Wifioff-sm",
		unicode: "ef69",
		unicode_decimal: 61289
	},
	{
		icon_id: "45682665",
		name: "Wifi off-md",
		font_class: "a-Wifioff-md",
		unicode: "ef6a",
		unicode_decimal: 61290
	},
	{
		icon_id: "45682664",
		name: "Wifi off-lg",
		font_class: "a-Wifioff-lg",
		unicode: "ef6b",
		unicode_decimal: 61291
	},
	{
		icon_id: "45682674",
		name: "X-lg",
		font_class: "X-lg",
		unicode: "ef61",
		unicode_decimal: 61281
	},
	{
		icon_id: "45682673",
		name: "Wind-xs",
		font_class: "Wind-xs",
		unicode: "ef62",
		unicode_decimal: 61282
	},
	{
		icon_id: "45682672",
		name: "Wind-xl",
		font_class: "Wind-xl",
		unicode: "ef63",
		unicode_decimal: 61283
	},
	{
		icon_id: "45682658",
		name: "Wifi-lg",
		font_class: "Wifi-lg",
		unicode: "ef5b",
		unicode_decimal: 61275
	},
	{
		icon_id: "45682657",
		name: "Watch-xs",
		font_class: "Watch-xs",
		unicode: "ef5c",
		unicode_decimal: 61276
	},
	{
		icon_id: "45682656",
		name: "Watch-xl",
		font_class: "Watch-xl",
		unicode: "ef5d",
		unicode_decimal: 61277
	},
	{
		icon_id: "45682655",
		name: "Watch-sm",
		font_class: "Watch-sm",
		unicode: "ef5e",
		unicode_decimal: 61278
	},
	{
		icon_id: "45682654",
		name: "Watch-md",
		font_class: "Watch-md",
		unicode: "ef5f",
		unicode_decimal: 61279
	},
	{
		icon_id: "45682653",
		name: "Watch-lg",
		font_class: "Watch-lg",
		unicode: "ef60",
		unicode_decimal: 61280
	},
	{
		icon_id: "45682663",
		name: "Wifi-xs",
		font_class: "Wifi-xs",
		unicode: "ef57",
		unicode_decimal: 61271
	},
	{
		icon_id: "45682661",
		name: "Wifi-xl",
		font_class: "Wifi-xl",
		unicode: "ef58",
		unicode_decimal: 61272
	},
	{
		icon_id: "45682660",
		name: "Wifi-sm",
		font_class: "Wifi-sm",
		unicode: "ef59",
		unicode_decimal: 61273
	},
	{
		icon_id: "45682659",
		name: "Wifi-md",
		font_class: "Wifi-md",
		unicode: "ef5a",
		unicode_decimal: 61274
	},
	{
		icon_id: "45682645",
		name: "Volume2-xl",
		font_class: "Volume2-xl",
		unicode: "ef53",
		unicode_decimal: 61267
	},
	{
		icon_id: "45682644",
		name: "Volume2-sm",
		font_class: "Volume2-sm",
		unicode: "ef54",
		unicode_decimal: 61268
	},
	{
		icon_id: "45682643",
		name: "Volume2-md",
		font_class: "Volume2-md",
		unicode: "ef55",
		unicode_decimal: 61269
	},
	{
		icon_id: "45682642",
		name: "Volume2-lg",
		font_class: "Volume2-lg",
		unicode: "ef56",
		unicode_decimal: 61270
	},
	{
		icon_id: "45682652",
		name: "Volume3-xs",
		font_class: "Volume3-xs",
		unicode: "ef4d",
		unicode_decimal: 61261
	},
	{
		icon_id: "45682651",
		name: "Volume3-xl",
		font_class: "Volume3-xl",
		unicode: "ef4e",
		unicode_decimal: 61262
	},
	{
		icon_id: "45682650",
		name: "Volume3-sm",
		font_class: "Volume3-sm",
		unicode: "ef4f",
		unicode_decimal: 61263
	},
	{
		icon_id: "45682649",
		name: "Volume3-md",
		font_class: "Volume3-md",
		unicode: "ef50",
		unicode_decimal: 61264
	},
	{
		icon_id: "45682648",
		name: "Volume3-lg",
		font_class: "Volume3-lg",
		unicode: "ef51",
		unicode_decimal: 61265
	},
	{
		icon_id: "45682646",
		name: "Volume2-xs",
		font_class: "Volume2-xs",
		unicode: "ef52",
		unicode_decimal: 61266
	},
	{
		icon_id: "45682636",
		name: "Volume-xs",
		font_class: "Volume-xs",
		unicode: "ef47",
		unicode_decimal: 61255
	},
	{
		icon_id: "45682635",
		name: "Volume-xl",
		font_class: "Volume-xl",
		unicode: "ef48",
		unicode_decimal: 61256
	},
	{
		icon_id: "45682634",
		name: "Volume-sm",
		font_class: "Volume-sm",
		unicode: "ef49",
		unicode_decimal: 61257
	},
	{
		icon_id: "45682633",
		name: "Volume-md",
		font_class: "Volume-md",
		unicode: "ef4a",
		unicode_decimal: 61258
	},
	{
		icon_id: "45682632",
		name: "Volume-lg",
		font_class: "Volume-lg",
		unicode: "ef4b",
		unicode_decimal: 61259
	},
	{
		icon_id: "45682631",
		name: "Voicemail-xs",
		font_class: "Voicemail-xs",
		unicode: "ef4c",
		unicode_decimal: 61260
	},
	{
		icon_id: "45682641",
		name: "Volume1-xs",
		font_class: "Volume1-xs",
		unicode: "ef42",
		unicode_decimal: 61250
	},
	{
		icon_id: "45682640",
		name: "Volume1-xl",
		font_class: "Volume1-xl",
		unicode: "ef43",
		unicode_decimal: 61251
	},
	{
		icon_id: "45682639",
		name: "Volume1-sm",
		font_class: "Volume1-sm",
		unicode: "ef44",
		unicode_decimal: 61252
	},
	{
		icon_id: "45682638",
		name: "Volume1-md",
		font_class: "Volume1-md",
		unicode: "ef45",
		unicode_decimal: 61253
	},
	{
		icon_id: "45682637",
		name: "Volume1-lg",
		font_class: "Volume1-lg",
		unicode: "ef46",
		unicode_decimal: 61254
	},
	{
		icon_id: "45682600",
		name: "Video-xl",
		font_class: "Video-xl",
		unicode: "ef41",
		unicode_decimal: 61249
	},
	{
		icon_id: "45682624",
		name: "Video off-sm",
		font_class: "a-Videooff-sm",
		unicode: "ef3d",
		unicode_decimal: 61245
	},
	{
		icon_id: "45682623",
		name: "Video off-md",
		font_class: "a-Videooff-md",
		unicode: "ef3e",
		unicode_decimal: 61246
	},
	{
		icon_id: "45682622",
		name: "Video off-lg",
		font_class: "a-Videooff-lg",
		unicode: "ef3f",
		unicode_decimal: 61247
	},
	{
		icon_id: "45682621",
		name: "Video-xs",
		font_class: "Video-xs",
		unicode: "ef40",
		unicode_decimal: 61248
	},
	{
		icon_id: "45682630",
		name: "Voicemail-xl",
		font_class: "Voicemail-xl",
		unicode: "ef37",
		unicode_decimal: 61239
	},
	{
		icon_id: "45682629",
		name: "Voicemail-sm",
		font_class: "Voicemail-sm",
		unicode: "ef38",
		unicode_decimal: 61240
	},
	{
		icon_id: "45682628",
		name: "Voicemail-md",
		font_class: "Voicemail-md",
		unicode: "ef39",
		unicode_decimal: 61241
	},
	{
		icon_id: "45682627",
		name: "Voicemail-lg",
		font_class: "Voicemail-lg",
		unicode: "ef3a",
		unicode_decimal: 61242
	},
	{
		icon_id: "45682626",
		name: "Video off-xs",
		font_class: "a-Videooff-xs",
		unicode: "ef3b",
		unicode_decimal: 61243
	},
	{
		icon_id: "45682625",
		name: "Video off-xl",
		font_class: "a-Videooff-xl",
		unicode: "ef3c",
		unicode_decimal: 61244
	},
	{
		icon_id: "45682594",
		name: "Variable-sm",
		font_class: "Variable-sm",
		unicode: "ef31",
		unicode_decimal: 61233
	},
	{
		icon_id: "45682593",
		name: "Variable-md",
		font_class: "Variable-md",
		unicode: "ef32",
		unicode_decimal: 61234
	},
	{
		icon_id: "45682592",
		name: "Variable-lg",
		font_class: "Variable-lg",
		unicode: "ef33",
		unicode_decimal: 61235
	},
	{
		icon_id: "45682591",
		name: "Users-xs",
		font_class: "Users-xs",
		unicode: "ef34",
		unicode_decimal: 61236
	},
	{
		icon_id: "45682590",
		name: "Users-xl",
		font_class: "Users-xl",
		unicode: "ef35",
		unicode_decimal: 61237
	},
	{
		icon_id: "45682589",
		name: "Users-sm",
		font_class: "Users-sm",
		unicode: "ef36",
		unicode_decimal: 61238
	},
	{
		icon_id: "45682599",
		name: "Video-sm",
		font_class: "Video-sm",
		unicode: "ef2c",
		unicode_decimal: 61228
	},
	{
		icon_id: "45682598",
		name: "Video-md",
		font_class: "Video-md",
		unicode: "ef2d",
		unicode_decimal: 61229
	},
	{
		icon_id: "45682597",
		name: "Video-lg",
		font_class: "Video-lg",
		unicode: "ef2e",
		unicode_decimal: 61230
	},
	{
		icon_id: "45682596",
		name: "Variable-xs",
		font_class: "Variable-xs",
		unicode: "ef2f",
		unicode_decimal: 61231
	},
	{
		icon_id: "45682595",
		name: "Variable-xl",
		font_class: "Variable-xl",
		unicode: "ef30",
		unicode_decimal: 61232
	},
	{
		icon_id: "45682583",
		name: "User x-md",
		font_class: "a-Userx-md",
		unicode: "ef26",
		unicode_decimal: 61222
	},
	{
		icon_id: "45682581",
		name: "User x-lg",
		font_class: "a-Userx-lg",
		unicode: "ef27",
		unicode_decimal: 61223
	},
	{
		icon_id: "45682580",
		name: "User plus-xs",
		font_class: "a-Userplus-xs",
		unicode: "ef28",
		unicode_decimal: 61224
	},
	{
		icon_id: "45682579",
		name: "User plus-xl",
		font_class: "a-Userplus-xl",
		unicode: "ef29",
		unicode_decimal: 61225
	},
	{
		icon_id: "45682578",
		name: "User plus-sm",
		font_class: "a-Userplus-sm",
		unicode: "ef2a",
		unicode_decimal: 61226
	},
	{
		icon_id: "45682577",
		name: "User plus-md",
		font_class: "a-Userplus-md",
		unicode: "ef2b",
		unicode_decimal: 61227
	},
	{
		icon_id: "45682588",
		name: "Users-md",
		font_class: "Users-md",
		unicode: "ef21",
		unicode_decimal: 61217
	},
	{
		icon_id: "45682587",
		name: "Users-lg",
		font_class: "Users-lg",
		unicode: "ef22",
		unicode_decimal: 61218
	},
	{
		icon_id: "45682586",
		name: "User x-xs",
		font_class: "a-Userx-xs",
		unicode: "ef23",
		unicode_decimal: 61219
	},
	{
		icon_id: "45682585",
		name: "User x-xl",
		font_class: "a-Userx-xl",
		unicode: "ef24",
		unicode_decimal: 61220
	},
	{
		icon_id: "45682584",
		name: "User x-sm",
		font_class: "a-Userx-sm",
		unicode: "ef25",
		unicode_decimal: 61221
	},
	{
		icon_id: "45682570",
		name: "User minus-lg",
		font_class: "a-Userminus-lg",
		unicode: "ef1b",
		unicode_decimal: 61211
	},
	{
		icon_id: "45682568",
		name: "User check-xs",
		font_class: "a-Usercheck-xs",
		unicode: "ef1c",
		unicode_decimal: 61212
	},
	{
		icon_id: "45682567",
		name: "User check-xl",
		font_class: "a-Usercheck-xl",
		unicode: "ef1d",
		unicode_decimal: 61213
	},
	{
		icon_id: "45682566",
		name: "User check-sm",
		font_class: "a-Usercheck-sm",
		unicode: "ef1e",
		unicode_decimal: 61214
	},
	{
		icon_id: "45682565",
		name: "User check-md",
		font_class: "a-Usercheck-md",
		unicode: "ef1f",
		unicode_decimal: 61215
	},
	{
		icon_id: "45682564",
		name: "User check-lg",
		font_class: "a-Usercheck-lg",
		unicode: "ef20",
		unicode_decimal: 61216
	},
	{
		icon_id: "45682576",
		name: "User plus-lg",
		font_class: "a-Userplus-lg",
		unicode: "ef16",
		unicode_decimal: 61206
	},
	{
		icon_id: "45682575",
		name: "User minus-xs",
		font_class: "a-Userminus-xs",
		unicode: "ef17",
		unicode_decimal: 61207
	},
	{
		icon_id: "45682574",
		name: "User minus-xl",
		font_class: "a-Userminus-xl",
		unicode: "ef18",
		unicode_decimal: 61208
	},
	{
		icon_id: "45682573",
		name: "User minus-sm",
		font_class: "a-Userminus-sm",
		unicode: "ef19",
		unicode_decimal: 61209
	},
	{
		icon_id: "45682571",
		name: "User minus-md",
		font_class: "a-Userminus-md",
		unicode: "ef1a",
		unicode_decimal: 61210
	},
	{
		icon_id: "45682563",
		name: "User-xs",
		font_class: "User-xs",
		unicode: "ef11",
		unicode_decimal: 61201
	},
	{
		icon_id: "45682562",
		name: "User-xl",
		font_class: "User-xl",
		unicode: "ef12",
		unicode_decimal: 61202
	},
	{
		icon_id: "45682561",
		name: "User-sm",
		font_class: "User-sm",
		unicode: "ef13",
		unicode_decimal: 61203
	},
	{
		icon_id: "45682560",
		name: "User-md",
		font_class: "User-md",
		unicode: "ef14",
		unicode_decimal: 61204
	},
	{
		icon_id: "45682559",
		name: "User-lg",
		font_class: "User-lg",
		unicode: "ef15",
		unicode_decimal: 61205
	},
	{
		icon_id: "45682550",
		name: "Upload cloud-xs",
		font_class: "a-Uploadcloud-xs",
		unicode: "ef0e",
		unicode_decimal: 61198
	},
	{
		icon_id: "45682549",
		name: "Upload cloud-xl",
		font_class: "a-Uploadcloud-xl",
		unicode: "ef0f",
		unicode_decimal: 61199
	},
	{
		icon_id: "45682548",
		name: "Upload cloud-sm",
		font_class: "a-Uploadcloud-sm",
		unicode: "ef10",
		unicode_decimal: 61200
	},
	{
		icon_id: "45682547",
		name: "Upload cloud-md",
		font_class: "a-Uploadcloud-md",
		unicode: "ef03",
		unicode_decimal: 61187
	},
	{
		icon_id: "45682546",
		name: "Upload cloud-lg",
		font_class: "a-Uploadcloud-lg",
		unicode: "ef04",
		unicode_decimal: 61188
	},
	{
		icon_id: "45682544",
		name: "Upload-xs",
		font_class: "Upload-xs",
		unicode: "ef05",
		unicode_decimal: 61189
	},
	{
		icon_id: "45682543",
		name: "Upload-xl",
		font_class: "Upload-xl",
		unicode: "ef06",
		unicode_decimal: 61190
	},
	{
		icon_id: "45682542",
		name: "Upload-sm",
		font_class: "Upload-sm",
		unicode: "ef07",
		unicode_decimal: 61191
	},
	{
		icon_id: "45682541",
		name: "Upload-md",
		font_class: "Upload-md",
		unicode: "ef08",
		unicode_decimal: 61192
	},
	{
		icon_id: "45682540",
		name: "Upload-lg",
		font_class: "Upload-lg",
		unicode: "ef09",
		unicode_decimal: 61193
	},
	{
		icon_id: "45682538",
		name: "Unlock-xs",
		font_class: "Unlock-xs",
		unicode: "ef0a",
		unicode_decimal: 61194
	},
	{
		icon_id: "45682537",
		name: "Unlock-xl",
		font_class: "Unlock-xl",
		unicode: "ef0b",
		unicode_decimal: 61195
	},
	{
		icon_id: "45682536",
		name: "Unlock-sm",
		font_class: "Unlock-sm",
		unicode: "ef0c",
		unicode_decimal: 61196
	},
	{
		icon_id: "45682535",
		name: "Unlock-md",
		font_class: "Unlock-md",
		unicode: "ef0d",
		unicode_decimal: 61197
	},
	{
		icon_id: "45682533",
		name: "Underline-xs",
		font_class: "Underline-xs",
		unicode: "eef9",
		unicode_decimal: 61177
	},
	{
		icon_id: "45682532",
		name: "Underline-xl",
		font_class: "Underline-xl",
		unicode: "eefa",
		unicode_decimal: 61178
	},
	{
		icon_id: "45682530",
		name: "Underline-sm",
		font_class: "Underline-sm",
		unicode: "eefb",
		unicode_decimal: 61179
	},
	{
		icon_id: "45682529",
		name: "Underline-md",
		font_class: "Underline-md",
		unicode: "eefc",
		unicode_decimal: 61180
	},
	{
		icon_id: "45682528",
		name: "Underline-lg",
		font_class: "Underline-lg",
		unicode: "eefd",
		unicode_decimal: 61181
	},
	{
		icon_id: "45682527",
		name: "Umbrella-xs",
		font_class: "Umbrella-xs",
		unicode: "eefe",
		unicode_decimal: 61182
	},
	{
		icon_id: "45682526",
		name: "Umbrella-xl",
		font_class: "Umbrella-xl",
		unicode: "eeff",
		unicode_decimal: 61183
	},
	{
		icon_id: "45682525",
		name: "Umbrella-sm",
		font_class: "Umbrella-sm",
		unicode: "ef00",
		unicode_decimal: 61184
	},
	{
		icon_id: "45682524",
		name: "Umbrella-md",
		font_class: "Umbrella-md",
		unicode: "ef01",
		unicode_decimal: 61185
	},
	{
		icon_id: "45682523",
		name: "Umbrella-lg",
		font_class: "Umbrella-lg",
		unicode: "ef02",
		unicode_decimal: 61186
	},
	{
		icon_id: "45682534",
		name: "Unlock-lg",
		font_class: "Unlock-lg",
		unicode: "eef8",
		unicode_decimal: 61176
	},
	{
		icon_id: "45682521",
		name: "Type-xl",
		font_class: "Type-xl",
		unicode: "eeef",
		unicode_decimal: 61167
	},
	{
		icon_id: "45682520",
		name: "Type-sm",
		font_class: "Type-sm",
		unicode: "eef0",
		unicode_decimal: 61168
	},
	{
		icon_id: "45682519",
		name: "Type-md",
		font_class: "Type-md",
		unicode: "eef1",
		unicode_decimal: 61169
	},
	{
		icon_id: "45682518",
		name: "Type-lg",
		font_class: "Type-lg",
		unicode: "eef2",
		unicode_decimal: 61170
	},
	{
		icon_id: "45682517",
		name: "icon-kfckfc",
		font_class: "Twitter-xs",
		unicode: "eef3",
		unicode_decimal: 61171
	},
	{
		icon_id: "45682516",
		name: "icon-kfckfc",
		font_class: "Twitter-xl",
		unicode: "eef4",
		unicode_decimal: 61172
	},
	{
		icon_id: "45682515",
		name: "icon-kfckfc",
		font_class: "Twitter-sm",
		unicode: "eef5",
		unicode_decimal: 61173
	},
	{
		icon_id: "45682514",
		name: "icon-kfckfc",
		font_class: "Twitter-md",
		unicode: "eef6",
		unicode_decimal: 61174
	},
	{
		icon_id: "45682513",
		name: "icon-kfckfc",
		font_class: "Twitter-lg",
		unicode: "eef7",
		unicode_decimal: 61175
	},
	{
		icon_id: "45682522",
		name: "Type-xs",
		font_class: "Type-xs",
		unicode: "eeee",
		unicode_decimal: 61166
	},
	{
		icon_id: "45682511",
		name: "Twitch-xl",
		font_class: "Twitch-xl",
		unicode: "eee5",
		unicode_decimal: 61157
	},
	{
		icon_id: "45682510",
		name: "Twitch-sm",
		font_class: "Twitch-sm",
		unicode: "eee6",
		unicode_decimal: 61158
	},
	{
		icon_id: "45682509",
		name: "Twitch-md",
		font_class: "Twitch-md",
		unicode: "eee7",
		unicode_decimal: 61159
	},
	{
		icon_id: "45682508",
		name: "Twitch-lg",
		font_class: "Twitch-lg",
		unicode: "eee8",
		unicode_decimal: 61160
	},
	{
		icon_id: "45682507",
		name: "Tv-xs",
		font_class: "Tv-xs",
		unicode: "eee9",
		unicode_decimal: 61161
	},
	{
		icon_id: "45682506",
		name: "Tv-xl",
		font_class: "Tv-xl",
		unicode: "eeea",
		unicode_decimal: 61162
	},
	{
		icon_id: "45682505",
		name: "Tv-sm",
		font_class: "Tv-sm",
		unicode: "eeeb",
		unicode_decimal: 61163
	},
	{
		icon_id: "45682504",
		name: "Tv-md",
		font_class: "Tv-md",
		unicode: "eeec",
		unicode_decimal: 61164
	},
	{
		icon_id: "45682503",
		name: "Tv-lg",
		font_class: "Tv-lg",
		unicode: "eeed",
		unicode_decimal: 61165
	},
	{
		icon_id: "45682512",
		name: "Twitch-xs",
		font_class: "Twitch-xs",
		unicode: "eee4",
		unicode_decimal: 61156
	},
	{
		icon_id: "45682501",
		name: "Truck-xl",
		font_class: "Truck-xl",
		unicode: "eeda",
		unicode_decimal: 61146
	},
	{
		icon_id: "45682500",
		name: "Truck-sm",
		font_class: "Truck-sm",
		unicode: "eedb",
		unicode_decimal: 61147
	},
	{
		icon_id: "45682499",
		name: "Truck-md",
		font_class: "Truck-md",
		unicode: "eedc",
		unicode_decimal: 61148
	},
	{
		icon_id: "45682498",
		name: "Truck-lg",
		font_class: "Truck-lg",
		unicode: "eedd",
		unicode_decimal: 61149
	},
	{
		icon_id: "45682497",
		name: "Triangle-xs",
		font_class: "Triangle-xs",
		unicode: "eede",
		unicode_decimal: 61150
	},
	{
		icon_id: "45682496",
		name: "Triangle-xl",
		font_class: "Triangle-xl",
		unicode: "eedf",
		unicode_decimal: 61151
	},
	{
		icon_id: "45682495",
		name: "Triangle-sm",
		font_class: "Triangle-sm",
		unicode: "eee0",
		unicode_decimal: 61152
	},
	{
		icon_id: "45682494",
		name: "Triangle-md",
		font_class: "Triangle-md",
		unicode: "eee1",
		unicode_decimal: 61153
	},
	{
		icon_id: "45682493",
		name: "Triangle-lg",
		font_class: "Triangle-lg",
		unicode: "eee2",
		unicode_decimal: 61154
	},
	{
		icon_id: "45682492",
		name: "Trending up-xs",
		font_class: "a-Trendingup-xs",
		unicode: "eee3",
		unicode_decimal: 61155
	},
	{
		icon_id: "45682502",
		name: "Truck-xs",
		font_class: "Truck-xs",
		unicode: "eed9",
		unicode_decimal: 61145
	},
	{
		icon_id: "45682463",
		name: "Trello-xs",
		font_class: "Trello-xs",
		unicode: "eed8",
		unicode_decimal: 61144
	},
	{
		icon_id: "45682490",
		name: "Trending up-sm",
		font_class: "a-Trendingup-sm",
		unicode: "eed0",
		unicode_decimal: 61136
	},
	{
		icon_id: "45682489",
		name: "Trending up-md",
		font_class: "a-Trendingup-md",
		unicode: "eed1",
		unicode_decimal: 61137
	},
	{
		icon_id: "45682488",
		name: "Trending up-lg",
		font_class: "a-Trendingup-lg",
		unicode: "eed2",
		unicode_decimal: 61138
	},
	{
		icon_id: "45682468",
		name: "Trending down-xs",
		font_class: "a-Trendingdown-xs",
		unicode: "eed3",
		unicode_decimal: 61139
	},
	{
		icon_id: "45682467",
		name: "Trending down-xl",
		font_class: "a-Trendingdown-xl",
		unicode: "eed4",
		unicode_decimal: 61140
	},
	{
		icon_id: "45682466",
		name: "Trending down-sm",
		font_class: "a-Trendingdown-sm",
		unicode: "eed5",
		unicode_decimal: 61141
	},
	{
		icon_id: "45682465",
		name: "Trending down-md",
		font_class: "a-Trendingdown-md",
		unicode: "eed6",
		unicode_decimal: 61142
	},
	{
		icon_id: "45682464",
		name: "Trending down-lg",
		font_class: "a-Trendingdown-lg",
		unicode: "eed7",
		unicode_decimal: 61143
	},
	{
		icon_id: "45682491",
		name: "Trending up-xl",
		font_class: "a-Trendingup-xl",
		unicode: "eecf",
		unicode_decimal: 61135
	},
	{
		icon_id: "45682460",
		name: "Trello-md",
		font_class: "Trello-md",
		unicode: "eec6",
		unicode_decimal: 61126
	},
	{
		icon_id: "45682459",
		name: "Trello-lg",
		font_class: "Trello-lg",
		unicode: "eec7",
		unicode_decimal: 61127
	},
	{
		icon_id: "45682457",
		name: "Trash2-xs",
		font_class: "Trash2-xs",
		unicode: "eec8",
		unicode_decimal: 61128
	},
	{
		icon_id: "45682456",
		name: "Trash2-xl",
		font_class: "Trash2-xl",
		unicode: "eec9",
		unicode_decimal: 61129
	},
	{
		icon_id: "45682455",
		name: "Trash2-sm",
		font_class: "Trash2-sm",
		unicode: "eeca",
		unicode_decimal: 61130
	},
	{
		icon_id: "45682454",
		name: "Trash2-md",
		font_class: "Trash2-md",
		unicode: "eecb",
		unicode_decimal: 61131
	},
	{
		icon_id: "45682453",
		name: "Trash2-lg",
		font_class: "Trash2-lg",
		unicode: "eecc",
		unicode_decimal: 61132
	},
	{
		icon_id: "45682452",
		name: "Trash-xs",
		font_class: "Trash-xs",
		unicode: "eecd",
		unicode_decimal: 61133
	},
	{
		icon_id: "45682451",
		name: "Trash-xl",
		font_class: "Trash-xl",
		unicode: "eece",
		unicode_decimal: 61134
	},
	{
		icon_id: "45682462",
		name: "Trello-xl",
		font_class: "Trello-xl",
		unicode: "eec4",
		unicode_decimal: 61124
	},
	{
		icon_id: "45682461",
		name: "Trello-sm",
		font_class: "Trello-sm",
		unicode: "eec5",
		unicode_decimal: 61125
	},
	{
		icon_id: "45682447",
		name: "Tool-xs",
		font_class: "Tool-xs",
		unicode: "eebb",
		unicode_decimal: 61115
	},
	{
		icon_id: "45682446",
		name: "Tool-xl",
		font_class: "Tool-xl",
		unicode: "eebc",
		unicode_decimal: 61116
	},
	{
		icon_id: "45682445",
		name: "Tool-sm",
		font_class: "Tool-sm",
		unicode: "eebd",
		unicode_decimal: 61117
	},
	{
		icon_id: "45682444",
		name: "Tool-md",
		font_class: "Tool-md",
		unicode: "eebe",
		unicode_decimal: 61118
	},
	{
		icon_id: "45682442",
		name: "Tool-lg",
		font_class: "Tool-lg",
		unicode: "eebf",
		unicode_decimal: 61119
	},
	{
		icon_id: "45682441",
		name: "Toggle right-xs",
		font_class: "a-Toggleright-xs",
		unicode: "eec0",
		unicode_decimal: 61120
	},
	{
		icon_id: "45682439",
		name: "Toggle right-xl",
		font_class: "a-Toggleright-xl",
		unicode: "eec1",
		unicode_decimal: 61121
	},
	{
		icon_id: "45682438",
		name: "Toggle right-sm",
		font_class: "a-Toggleright-sm",
		unicode: "eec2",
		unicode_decimal: 61122
	},
	{
		icon_id: "45682437",
		name: "Toggle right-md",
		font_class: "a-Toggleright-md",
		unicode: "eec3",
		unicode_decimal: 61123
	},
	{
		icon_id: "45682450",
		name: "Trash-sm",
		font_class: "Trash-sm",
		unicode: "eeb8",
		unicode_decimal: 61112
	},
	{
		icon_id: "45682449",
		name: "Trash-md",
		font_class: "Trash-md",
		unicode: "eeb9",
		unicode_decimal: 61113
	},
	{
		icon_id: "45682448",
		name: "Trash-lg",
		font_class: "Trash-lg",
		unicode: "eeba",
		unicode_decimal: 61114
	},
	{
		icon_id: "45682432",
		name: "Toggle left-xl",
		font_class: "a-Toggleleft-xl",
		unicode: "eeb0",
		unicode_decimal: 61104
	},
	{
		icon_id: "45682431",
		name: "Toggle left-sm",
		font_class: "a-Toggleleft-sm",
		unicode: "eeb1",
		unicode_decimal: 61105
	},
	{
		icon_id: "45682430",
		name: "Toggle left-md",
		font_class: "a-Toggleleft-md",
		unicode: "eeb2",
		unicode_decimal: 61106
	},
	{
		icon_id: "45682429",
		name: "Toggle left-lg",
		font_class: "a-Toggleleft-lg",
		unicode: "eeb3",
		unicode_decimal: 61107
	},
	{
		icon_id: "45682428",
		name: "Thumbs up-xs",
		font_class: "a-Thumbsup-xs",
		unicode: "eeb4",
		unicode_decimal: 61108
	},
	{
		icon_id: "45682427",
		name: "Thumbs up-xl",
		font_class: "a-Thumbsup-xl",
		unicode: "eeb5",
		unicode_decimal: 61109
	},
	{
		icon_id: "45682426",
		name: "Thumbs up-sm",
		font_class: "a-Thumbsup-sm",
		unicode: "eeb6",
		unicode_decimal: 61110
	},
	{
		icon_id: "45682425",
		name: "Thumbs up-md",
		font_class: "a-Thumbsup-md",
		unicode: "eeb7",
		unicode_decimal: 61111
	},
	{
		icon_id: "45682435",
		name: "Toggle right-lg",
		font_class: "a-Toggleright-lg",
		unicode: "eeae",
		unicode_decimal: 61102
	},
	{
		icon_id: "45682433",
		name: "Toggle left-xs",
		font_class: "a-Toggleleft-xs",
		unicode: "eeaf",
		unicode_decimal: 61103
	},
	{
		icon_id: "45682422",
		name: "Thumbs down-xl",
		font_class: "a-Thumbsdown-xl",
		unicode: "eea5",
		unicode_decimal: 61093
	},
	{
		icon_id: "45682421",
		name: "Thumbs down-sm",
		font_class: "a-Thumbsdown-sm",
		unicode: "eea6",
		unicode_decimal: 61094
	},
	{
		icon_id: "45682420",
		name: "Thumbs down-md",
		font_class: "a-Thumbsdown-md",
		unicode: "eea7",
		unicode_decimal: 61095
	},
	{
		icon_id: "45682419",
		name: "Thumbs down-lg",
		font_class: "a-Thumbsdown-lg",
		unicode: "eea8",
		unicode_decimal: 61096
	},
	{
		icon_id: "45682418",
		name: "Thermometer-xs",
		font_class: "Thermometer-xs",
		unicode: "eea9",
		unicode_decimal: 61097
	},
	{
		icon_id: "45682417",
		name: "Thermometer-xl",
		font_class: "Thermometer-xl",
		unicode: "eeaa",
		unicode_decimal: 61098
	},
	{
		icon_id: "45682416",
		name: "Thermometer-sm",
		font_class: "Thermometer-sm",
		unicode: "eeab",
		unicode_decimal: 61099
	},
	{
		icon_id: "45682415",
		name: "Thermometer-md",
		font_class: "Thermometer-md",
		unicode: "eeac",
		unicode_decimal: 61100
	},
	{
		icon_id: "45682414",
		name: "Thermometer-lg",
		font_class: "Thermometer-lg",
		unicode: "eead",
		unicode_decimal: 61101
	},
	{
		icon_id: "45682424",
		name: "Thumbs up-lg",
		font_class: "a-Thumbsup-lg",
		unicode: "eea3",
		unicode_decimal: 61091
	},
	{
		icon_id: "45682423",
		name: "Thumbs down-xs",
		font_class: "a-Thumbsdown-xs",
		unicode: "eea4",
		unicode_decimal: 61092
	},
	{
		icon_id: "45682409",
		name: "Terminal-lg",
		font_class: "Terminal-lg",
		unicode: "ee9d",
		unicode_decimal: 61085
	},
	{
		icon_id: "45682408",
		name: "Target-xs",
		font_class: "Target-xs",
		unicode: "ee9e",
		unicode_decimal: 61086
	},
	{
		icon_id: "45682407",
		name: "Target-xl",
		font_class: "Target-xl",
		unicode: "ee9f",
		unicode_decimal: 61087
	},
	{
		icon_id: "45682406",
		name: "Target-sm",
		font_class: "Target-sm",
		unicode: "eea0",
		unicode_decimal: 61088
	},
	{
		icon_id: "45682405",
		name: "Target-md",
		font_class: "Target-md",
		unicode: "eea1",
		unicode_decimal: 61089
	},
	{
		icon_id: "45682404",
		name: "Target-lg",
		font_class: "Target-lg",
		unicode: "eea2",
		unicode_decimal: 61090
	},
	{
		icon_id: "45682413",
		name: "Terminal-xs",
		font_class: "Terminal-xs",
		unicode: "ee99",
		unicode_decimal: 61081
	},
	{
		icon_id: "45682412",
		name: "Terminal-xl",
		font_class: "Terminal-xl",
		unicode: "ee9a",
		unicode_decimal: 61082
	},
	{
		icon_id: "45682411",
		name: "Terminal-sm",
		font_class: "Terminal-sm",
		unicode: "ee9b",
		unicode_decimal: 61083
	},
	{
		icon_id: "45682410",
		name: "Terminal-md",
		font_class: "Terminal-md",
		unicode: "ee9c",
		unicode_decimal: 61084
	},
	{
		icon_id: "45682399",
		name: "Tag-lg",
		font_class: "Tag-lg",
		unicode: "ee93",
		unicode_decimal: 61075
	},
	{
		icon_id: "45682398",
		name: "Tablet-xs",
		font_class: "Tablet-xs",
		unicode: "ee94",
		unicode_decimal: 61076
	},
	{
		icon_id: "45682397",
		name: "Tablet-xl",
		font_class: "Tablet-xl",
		unicode: "ee95",
		unicode_decimal: 61077
	},
	{
		icon_id: "45682396",
		name: "Tablet-sm",
		font_class: "Tablet-sm",
		unicode: "ee96",
		unicode_decimal: 61078
	},
	{
		icon_id: "45682395",
		name: "Tablet-md",
		font_class: "Tablet-md",
		unicode: "ee97",
		unicode_decimal: 61079
	},
	{
		icon_id: "45682394",
		name: "Tablet-lg",
		font_class: "Tablet-lg",
		unicode: "ee98",
		unicode_decimal: 61080
	},
	{
		icon_id: "45682403",
		name: "Tag-xs",
		font_class: "Tag-xs",
		unicode: "ee8f",
		unicode_decimal: 61071
	},
	{
		icon_id: "45682402",
		name: "Tag-xl",
		font_class: "Tag-xl",
		unicode: "ee90",
		unicode_decimal: 61072
	},
	{
		icon_id: "45682401",
		name: "Tag-sm",
		font_class: "Tag-sm",
		unicode: "ee91",
		unicode_decimal: 61073
	},
	{
		icon_id: "45682400",
		name: "Tag-md",
		font_class: "Tag-md",
		unicode: "ee92",
		unicode_decimal: 61074
	},
	{
		icon_id: "45682388",
		name: "Tab-xs",
		font_class: "Tab-xs",
		unicode: "ee89",
		unicode_decimal: 61065
	},
	{
		icon_id: "45682387",
		name: "Tab-xl",
		font_class: "Tab-xl",
		unicode: "ee8a",
		unicode_decimal: 61066
	},
	{
		icon_id: "45682386",
		name: "Tab-sm",
		font_class: "Tab-sm",
		unicode: "ee8b",
		unicode_decimal: 61067
	},
	{
		icon_id: "45682385",
		name: "Tab-md",
		font_class: "Tab-md",
		unicode: "ee8c",
		unicode_decimal: 61068
	},
	{
		icon_id: "45682384",
		name: "Tab-lg",
		font_class: "Tab-lg",
		unicode: "ee8d",
		unicode_decimal: 61069
	},
	{
		icon_id: "45682383",
		name: "Sunset-xs",
		font_class: "Sunset-xs",
		unicode: "ee8e",
		unicode_decimal: 61070
	},
	{
		icon_id: "45682393",
		name: "Table-xs",
		font_class: "Table-xs",
		unicode: "ee84",
		unicode_decimal: 61060
	},
	{
		icon_id: "45682392",
		name: "Table-xl",
		font_class: "Table-xl",
		unicode: "ee85",
		unicode_decimal: 61061
	},
	{
		icon_id: "45682391",
		name: "Table-sm",
		font_class: "Table-sm",
		unicode: "ee86",
		unicode_decimal: 61062
	},
	{
		icon_id: "45682390",
		name: "Table-md",
		font_class: "Table-md",
		unicode: "ee87",
		unicode_decimal: 61063
	},
	{
		icon_id: "45682389",
		name: "Table-lg",
		font_class: "Table-lg",
		unicode: "ee88",
		unicode_decimal: 61064
	},
	{
		icon_id: "45682377",
		name: "Sunrise-xl",
		font_class: "Sunrise-xl",
		unicode: "ee7e",
		unicode_decimal: 61054
	},
	{
		icon_id: "45682376",
		name: "Sunrise-sm",
		font_class: "Sunrise-sm",
		unicode: "ee7f",
		unicode_decimal: 61055
	},
	{
		icon_id: "45682375",
		name: "Sunrise-md",
		font_class: "Sunrise-md",
		unicode: "ee80",
		unicode_decimal: 61056
	},
	{
		icon_id: "45682374",
		name: "Sunrise-lg",
		font_class: "Sunrise-lg",
		unicode: "ee81",
		unicode_decimal: 61057
	},
	{
		icon_id: "45682373",
		name: "Sun-xs",
		font_class: "Sun-xs",
		unicode: "ee82",
		unicode_decimal: 61058
	},
	{
		icon_id: "45682372",
		name: "Sun-xl",
		font_class: "Sun-xl",
		unicode: "ee83",
		unicode_decimal: 61059
	},
	{
		icon_id: "45682382",
		name: "Sunset-xl",
		font_class: "Sunset-xl",
		unicode: "ee79",
		unicode_decimal: 61049
	},
	{
		icon_id: "45682381",
		name: "Sunset-sm",
		font_class: "Sunset-sm",
		unicode: "ee7a",
		unicode_decimal: 61050
	},
	{
		icon_id: "45682380",
		name: "Sunset-md",
		font_class: "Sunset-md",
		unicode: "ee7b",
		unicode_decimal: 61051
	},
	{
		icon_id: "45682379",
		name: "Sunset-lg",
		font_class: "Sunset-lg",
		unicode: "ee7c",
		unicode_decimal: 61052
	},
	{
		icon_id: "45682378",
		name: "Sunrise-xs",
		font_class: "Sunrise-xs",
		unicode: "ee7d",
		unicode_decimal: 61053
	},
	{
		icon_id: "45682366",
		name: "Stop circle-sm",
		font_class: "a-Stopcircle-sm",
		unicode: "ee73",
		unicode_decimal: 61043
	},
	{
		icon_id: "45682365",
		name: "Stop circle-md",
		font_class: "a-Stopcircle-md",
		unicode: "ee74",
		unicode_decimal: 61044
	},
	{
		icon_id: "45682364",
		name: "Stop circle-lg",
		font_class: "a-Stopcircle-lg",
		unicode: "ee75",
		unicode_decimal: 61045
	},
	{
		icon_id: "45682363",
		name: "Star-xs",
		font_class: "Star-xs",
		unicode: "ee76",
		unicode_decimal: 61046
	},
	{
		icon_id: "45682362",
		name: "Star-xl",
		font_class: "Star-xl",
		unicode: "ee77",
		unicode_decimal: 61047
	},
	{
		icon_id: "45682361",
		name: "Star-sm",
		font_class: "Star-sm",
		unicode: "ee78",
		unicode_decimal: 61048
	},
	{
		icon_id: "45682371",
		name: "Sun-sm",
		font_class: "Sun-sm",
		unicode: "ee6e",
		unicode_decimal: 61038
	},
	{
		icon_id: "45682370",
		name: "Sun-md",
		font_class: "Sun-md",
		unicode: "ee6f",
		unicode_decimal: 61039
	},
	{
		icon_id: "45682369",
		name: "Sun-lg",
		font_class: "Sun-lg",
		unicode: "ee70",
		unicode_decimal: 61040
	},
	{
		icon_id: "45682368",
		name: "Stop circle-xs",
		font_class: "a-Stopcircle-xs",
		unicode: "ee71",
		unicode_decimal: 61041
	},
	{
		icon_id: "45682367",
		name: "Stop circle-xl",
		font_class: "a-Stopcircle-xl",
		unicode: "ee72",
		unicode_decimal: 61042
	},
	{
		icon_id: "45682357",
		name: "Square-xl",
		font_class: "Square-xl",
		unicode: "ee66",
		unicode_decimal: 61030
	},
	{
		icon_id: "45682356",
		name: "Square-sm",
		font_class: "Square-sm",
		unicode: "ee67",
		unicode_decimal: 61031
	},
	{
		icon_id: "45682355",
		name: "Square-md",
		font_class: "Square-md",
		unicode: "ee68",
		unicode_decimal: 61032
	},
	{
		icon_id: "45682354",
		name: "Square-lg",
		font_class: "Square-lg",
		unicode: "ee69",
		unicode_decimal: 61033
	},
	{
		icon_id: "45682353",
		name: "Speaker-xs",
		font_class: "Speaker-xs",
		unicode: "ee6a",
		unicode_decimal: 61034
	},
	{
		icon_id: "45682352",
		name: "Speaker-xl",
		font_class: "Speaker-xl",
		unicode: "ee6b",
		unicode_decimal: 61035
	},
	{
		icon_id: "45682351",
		name: "Speaker-sm",
		font_class: "Speaker-sm",
		unicode: "ee6c",
		unicode_decimal: 61036
	},
	{
		icon_id: "45682350",
		name: "Speaker-md",
		font_class: "Speaker-md",
		unicode: "ee6d",
		unicode_decimal: 61037
	},
	{
		icon_id: "45682360",
		name: "Star-md",
		font_class: "Star-md",
		unicode: "ee63",
		unicode_decimal: 61027
	},
	{
		icon_id: "45682359",
		name: "Star-lg",
		font_class: "Star-lg",
		unicode: "ee64",
		unicode_decimal: 61028
	},
	{
		icon_id: "45682358",
		name: "Square-xs",
		font_class: "Square-xs",
		unicode: "ee65",
		unicode_decimal: 61029
	},
	{
		icon_id: "45682344",
		name: "Sort-lg",
		font_class: "Sort-lg",
		unicode: "ee5d",
		unicode_decimal: 61021
	},
	{
		icon_id: "45682343",
		name: "Smile-xs",
		font_class: "Smile-xs",
		unicode: "ee5e",
		unicode_decimal: 61022
	},
	{
		icon_id: "45682342",
		name: "Smile-xl",
		font_class: "Smile-xl",
		unicode: "ee5f",
		unicode_decimal: 61023
	},
	{
		icon_id: "45682341",
		name: "Smile-sm",
		font_class: "Smile-sm",
		unicode: "ee60",
		unicode_decimal: 61024
	},
	{
		icon_id: "45682340",
		name: "Smile-md",
		font_class: "Smile-md",
		unicode: "ee61",
		unicode_decimal: 61025
	},
	{
		icon_id: "45682339",
		name: "Smile-lg",
		font_class: "Smile-lg",
		unicode: "ee62",
		unicode_decimal: 61026
	},
	{
		icon_id: "45682349",
		name: "Speaker-lg",
		font_class: "Speaker-lg",
		unicode: "ee58",
		unicode_decimal: 61016
	},
	{
		icon_id: "45682348",
		name: "Sort-xs",
		font_class: "Sort-xs",
		unicode: "ee59",
		unicode_decimal: 61017
	},
	{
		icon_id: "45682347",
		name: "Sort-xl",
		font_class: "Sort-xl",
		unicode: "ee5a",
		unicode_decimal: 61018
	},
	{
		icon_id: "45682346",
		name: "Sort-sm",
		font_class: "Sort-sm",
		unicode: "ee5b",
		unicode_decimal: 61019
	},
	{
		icon_id: "45682345",
		name: "Sort-md",
		font_class: "Sort-md",
		unicode: "ee5c",
		unicode_decimal: 61020
	},
	{
		icon_id: "45682333",
		name: "Sliders-xs",
		font_class: "Sliders-xs",
		unicode: "ee53",
		unicode_decimal: 61011
	},
	{
		icon_id: "45682332",
		name: "Sliders-xl",
		font_class: "Sliders-xl",
		unicode: "ee54",
		unicode_decimal: 61012
	},
	{
		icon_id: "45682331",
		name: "Sliders-sm",
		font_class: "Sliders-sm",
		unicode: "ee55",
		unicode_decimal: 61013
	},
	{
		icon_id: "45682330",
		name: "Sliders-md",
		font_class: "Sliders-md",
		unicode: "ee56",
		unicode_decimal: 61014
	},
	{
		icon_id: "45682329",
		name: "Sliders-lg",
		font_class: "Sliders-lg",
		unicode: "ee57",
		unicode_decimal: 61015
	},
	{
		icon_id: "45682338",
		name: "Smartphone-xs",
		font_class: "Smartphone-xs",
		unicode: "ee4e",
		unicode_decimal: 61006
	},
	{
		icon_id: "45682337",
		name: "Smartphone-xl",
		font_class: "Smartphone-xl",
		unicode: "ee4f",
		unicode_decimal: 61007
	},
	{
		icon_id: "45682336",
		name: "Smartphone-sm",
		font_class: "Smartphone-sm",
		unicode: "ee50",
		unicode_decimal: 61008
	},
	{
		icon_id: "45682335",
		name: "Smartphone-md",
		font_class: "Smartphone-md",
		unicode: "ee51",
		unicode_decimal: 61009
	},
	{
		icon_id: "45682334",
		name: "Smartphone-lg",
		font_class: "Smartphone-lg",
		unicode: "ee52",
		unicode_decimal: 61010
	},
	{
		icon_id: "45682322",
		name: "Skip forward-xl",
		font_class: "a-Skipforward-xl",
		unicode: "ee49",
		unicode_decimal: 61001
	},
	{
		icon_id: "45682321",
		name: "Skip forward-sm",
		font_class: "a-Skipforward-sm",
		unicode: "ee4a",
		unicode_decimal: 61002
	},
	{
		icon_id: "45682320",
		name: "Skip forward-md",
		font_class: "a-Skipforward-md",
		unicode: "ee4b",
		unicode_decimal: 61003
	},
	{
		icon_id: "45682319",
		name: "Skip forward-lg",
		font_class: "a-Skipforward-lg",
		unicode: "ee4c",
		unicode_decimal: 61004
	},
	{
		icon_id: "45682318",
		name: "Skip back-xs",
		font_class: "a-Skipback-xs",
		unicode: "ee4d",
		unicode_decimal: 61005
	},
	{
		icon_id: "45682328",
		name: "Slash-xs",
		font_class: "Slash-xs",
		unicode: "ee43",
		unicode_decimal: 60995
	},
	{
		icon_id: "45682327",
		name: "Slash-xl",
		font_class: "Slash-xl",
		unicode: "ee44",
		unicode_decimal: 60996
	},
	{
		icon_id: "45682326",
		name: "Slash-sm",
		font_class: "Slash-sm",
		unicode: "ee45",
		unicode_decimal: 60997
	},
	{
		icon_id: "45682325",
		name: "Slash-md",
		font_class: "Slash-md",
		unicode: "ee46",
		unicode_decimal: 60998
	},
	{
		icon_id: "45682324",
		name: "Slash-lg",
		font_class: "Slash-lg",
		unicode: "ee47",
		unicode_decimal: 60999
	},
	{
		icon_id: "45682323",
		name: "Skip forward-xs",
		font_class: "a-Skipforward-xs",
		unicode: "ee48",
		unicode_decimal: 61000
	},
	{
		icon_id: "45682306",
		name: "Shuffle-xs",
		font_class: "Shuffle-xs",
		unicode: "ee3c",
		unicode_decimal: 60988
	},
	{
		icon_id: "45682305",
		name: "Shuffle-xl",
		font_class: "Shuffle-xl",
		unicode: "ee3d",
		unicode_decimal: 60989
	},
	{
		icon_id: "45682304",
		name: "Shuffle-sm",
		font_class: "Shuffle-sm",
		unicode: "ee3e",
		unicode_decimal: 60990
	},
	{
		icon_id: "45682303",
		name: "Shuffle-md",
		font_class: "Shuffle-md",
		unicode: "ee3f",
		unicode_decimal: 60991
	},
	{
		icon_id: "45682302",
		name: "Shuffle-lg",
		font_class: "Shuffle-lg",
		unicode: "ee40",
		unicode_decimal: 60992
	},
	{
		icon_id: "45682301",
		name: "Shopping cart-xs",
		font_class: "a-Shoppingcart-xs",
		unicode: "ee41",
		unicode_decimal: 60993
	},
	{
		icon_id: "45682300",
		name: "Shopping cart-xl",
		font_class: "a-Shoppingcart-xl",
		unicode: "ee42",
		unicode_decimal: 60994
	},
	{
		icon_id: "45682317",
		name: "Skip back-xl",
		font_class: "a-Skipback-xl",
		unicode: "ee38",
		unicode_decimal: 60984
	},
	{
		icon_id: "45682316",
		name: "Skip back-sm",
		font_class: "a-Skipback-sm",
		unicode: "ee39",
		unicode_decimal: 60985
	},
	{
		icon_id: "45682315",
		name: "Skip back-md",
		font_class: "a-Skipback-md",
		unicode: "ee3a",
		unicode_decimal: 60986
	},
	{
		icon_id: "45682314",
		name: "Skip back-lg",
		font_class: "a-Skipback-lg",
		unicode: "ee3b",
		unicode_decimal: 60987
	},
	{
		icon_id: "45682292",
		name: "Shopping bag-md",
		font_class: "a-Shoppingbag-md",
		unicode: "ee33",
		unicode_decimal: 60979
	},
	{
		icon_id: "45682291",
		name: "Shopping bag-lg",
		font_class: "a-Shoppingbag-lg",
		unicode: "ee34",
		unicode_decimal: 60980
	},
	{
		icon_id: "45682289",
		name: "Shift-xs",
		font_class: "Shift-xs",
		unicode: "ee35",
		unicode_decimal: 60981
	},
	{
		icon_id: "45682288",
		name: "Shift-xl",
		font_class: "Shift-xl",
		unicode: "ee36",
		unicode_decimal: 60982
	},
	{
		icon_id: "45682287",
		name: "Shift-sm",
		font_class: "Shift-sm",
		unicode: "ee37",
		unicode_decimal: 60983
	},
	{
		icon_id: "45682299",
		name: "Shopping cart-sm",
		font_class: "a-Shoppingcart-sm",
		unicode: "ee2d",
		unicode_decimal: 60973
	},
	{
		icon_id: "45682298",
		name: "Shopping cart-md",
		font_class: "a-Shoppingcart-md",
		unicode: "ee2e",
		unicode_decimal: 60974
	},
	{
		icon_id: "45682297",
		name: "Shopping cart-lg",
		font_class: "a-Shoppingcart-lg",
		unicode: "ee2f",
		unicode_decimal: 60975
	},
	{
		icon_id: "45682296",
		name: "Shopping bag-xs",
		font_class: "a-Shoppingbag-xs",
		unicode: "ee30",
		unicode_decimal: 60976
	},
	{
		icon_id: "45682295",
		name: "Shopping bag-xl",
		font_class: "a-Shoppingbag-xl",
		unicode: "ee31",
		unicode_decimal: 60977
	},
	{
		icon_id: "45682293",
		name: "Shopping bag-sm",
		font_class: "a-Shoppingbag-sm",
		unicode: "ee32",
		unicode_decimal: 60978
	},
	{
		icon_id: "45682286",
		name: "Shift-md",
		font_class: "Shift-md",
		unicode: "ee2b",
		unicode_decimal: 60971
	},
	{
		icon_id: "45682285",
		name: "Shift-lg",
		font_class: "Shift-lg",
		unicode: "ee2c",
		unicode_decimal: 60972
	},
	{
		icon_id: "45682233",
		name: "Shield-xl",
		font_class: "Shield-xl",
		unicode: "ee23",
		unicode_decimal: 60963
	},
	{
		icon_id: "45682232",
		name: "Shield-sm",
		font_class: "Shield-sm",
		unicode: "ee24",
		unicode_decimal: 60964
	},
	{
		icon_id: "45682231",
		name: "Shield-md",
		font_class: "Shield-md",
		unicode: "ee25",
		unicode_decimal: 60965
	},
	{
		icon_id: "45682230",
		name: "Shield-lg",
		font_class: "Shield-lg",
		unicode: "ee26",
		unicode_decimal: 60966
	},
	{
		icon_id: "45682229",
		name: "Share2-xs",
		font_class: "Share2-xs",
		unicode: "ee27",
		unicode_decimal: 60967
	},
	{
		icon_id: "45682228",
		name: "Share2-xl",
		font_class: "Share2-xl",
		unicode: "ee28",
		unicode_decimal: 60968
	},
	{
		icon_id: "45682227",
		name: "Share2-sm",
		font_class: "Share2-sm",
		unicode: "ee29",
		unicode_decimal: 60969
	},
	{
		icon_id: "45682226",
		name: "Share2-md",
		font_class: "Share2-md",
		unicode: "ee2a",
		unicode_decimal: 60970
	},
	{
		icon_id: "45682235",
		name: "Shield-xs",
		font_class: "Shield-xs",
		unicode: "ee22",
		unicode_decimal: 60962
	},
	{
		icon_id: "45682224",
		name: "Share-xs",
		font_class: "Share-xs",
		unicode: "ee18",
		unicode_decimal: 60952
	},
	{
		icon_id: "45682223",
		name: "Share-xl",
		font_class: "Share-xl",
		unicode: "ee19",
		unicode_decimal: 60953
	},
	{
		icon_id: "45682222",
		name: "Share-sm",
		font_class: "Share-sm",
		unicode: "ee1a",
		unicode_decimal: 60954
	},
	{
		icon_id: "45682221",
		name: "Share-md",
		font_class: "Share-md",
		unicode: "ee1b",
		unicode_decimal: 60955
	},
	{
		icon_id: "45682220",
		name: "Share-lg",
		font_class: "Share-lg",
		unicode: "ee1c",
		unicode_decimal: 60956
	},
	{
		icon_id: "45682219",
		name: "Settings-xs",
		font_class: "Settings-xs",
		unicode: "ee1d",
		unicode_decimal: 60957
	},
	{
		icon_id: "45682218",
		name: "Settings-xl",
		font_class: "Settings-xl",
		unicode: "ee1e",
		unicode_decimal: 60958
	},
	{
		icon_id: "45682217",
		name: "Settings-sm",
		font_class: "Settings-sm",
		unicode: "ee1f",
		unicode_decimal: 60959
	},
	{
		icon_id: "45682215",
		name: "Settings-md",
		font_class: "Settings-md",
		unicode: "ee20",
		unicode_decimal: 60960
	},
	{
		icon_id: "45682214",
		name: "Settings-lg",
		font_class: "Settings-lg",
		unicode: "ee21",
		unicode_decimal: 60961
	},
	{
		icon_id: "45682225",
		name: "Share2-lg",
		font_class: "Share2-lg",
		unicode: "ee17",
		unicode_decimal: 60951
	},
	{
		icon_id: "45682211",
		name: "Server-xl",
		font_class: "Server-xl",
		unicode: "ee0e",
		unicode_decimal: 60942
	},
	{
		icon_id: "45682210",
		name: "Server-sm",
		font_class: "Server-sm",
		unicode: "ee0f",
		unicode_decimal: 60943
	},
	{
		icon_id: "45682209",
		name: "Server-md",
		font_class: "Server-md",
		unicode: "ee10",
		unicode_decimal: 60944
	},
	{
		icon_id: "45682208",
		name: "Server-lg",
		font_class: "Server-lg",
		unicode: "ee11",
		unicode_decimal: 60945
	},
	{
		icon_id: "45682207",
		name: "Send-xs",
		font_class: "Send-xs",
		unicode: "ee12",
		unicode_decimal: 60946
	},
	{
		icon_id: "45682206",
		name: "Send-xl",
		font_class: "Send-xl",
		unicode: "ee13",
		unicode_decimal: 60947
	},
	{
		icon_id: "45682205",
		name: "Send-sm",
		font_class: "Send-sm",
		unicode: "ee14",
		unicode_decimal: 60948
	},
	{
		icon_id: "45682204",
		name: "Send-md",
		font_class: "Send-md",
		unicode: "ee15",
		unicode_decimal: 60949
	},
	{
		icon_id: "45682203",
		name: "Send-lg",
		font_class: "Send-lg",
		unicode: "ee16",
		unicode_decimal: 60950
	},
	{
		icon_id: "45682212",
		name: "Server-xs",
		font_class: "Server-xs",
		unicode: "ee0d",
		unicode_decimal: 60941
	},
	{
		icon_id: "45682187",
		name: "Save-xs",
		font_class: "Save-xs",
		unicode: "ee0c",
		unicode_decimal: 60940
	},
	{
		icon_id: "45682201",
		name: "Search-xl",
		font_class: "Search-xl",
		unicode: "ee03",
		unicode_decimal: 60931
	},
	{
		icon_id: "45682200",
		name: "Search-sm",
		font_class: "Search-sm",
		unicode: "ee04",
		unicode_decimal: 60932
	},
	{
		icon_id: "45682194",
		name: "Search-md",
		font_class: "Search-md",
		unicode: "ee05",
		unicode_decimal: 60933
	},
	{
		icon_id: "45682193",
		name: "Search-lg",
		font_class: "Search-lg",
		unicode: "ee06",
		unicode_decimal: 60934
	},
	{
		icon_id: "45682192",
		name: "Scissors-xs",
		font_class: "Scissors-xs",
		unicode: "ee07",
		unicode_decimal: 60935
	},
	{
		icon_id: "45682191",
		name: "Scissors-xl",
		font_class: "Scissors-xl",
		unicode: "ee08",
		unicode_decimal: 60936
	},
	{
		icon_id: "45682190",
		name: "Scissors-sm",
		font_class: "Scissors-sm",
		unicode: "ee09",
		unicode_decimal: 60937
	},
	{
		icon_id: "45682189",
		name: "Scissors-md",
		font_class: "Scissors-md",
		unicode: "ee0a",
		unicode_decimal: 60938
	},
	{
		icon_id: "45682188",
		name: "Scissors-lg",
		font_class: "Scissors-lg",
		unicode: "ee0b",
		unicode_decimal: 60939
	},
	{
		icon_id: "45682202",
		name: "Search-xs",
		font_class: "Search-xs",
		unicode: "ee02",
		unicode_decimal: 60930
	},
	{
		icon_id: "45682183",
		name: "Save-lg",
		font_class: "Save-lg",
		unicode: "edfa",
		unicode_decimal: 60922
	},
	{
		icon_id: "45682182",
		name: "Rss-xs",
		font_class: "Rss-xs",
		unicode: "edfb",
		unicode_decimal: 60923
	},
	{
		icon_id: "45682181",
		name: "Rss-xl",
		font_class: "Rss-xl",
		unicode: "edfc",
		unicode_decimal: 60924
	},
	{
		icon_id: "45682180",
		name: "Rss-sm",
		font_class: "Rss-sm",
		unicode: "edfd",
		unicode_decimal: 60925
	},
	{
		icon_id: "45682178",
		name: "Rss-md",
		font_class: "Rss-md",
		unicode: "edfe",
		unicode_decimal: 60926
	},
	{
		icon_id: "45682177",
		name: "Rss-lg",
		font_class: "Rss-lg",
		unicode: "edff",
		unicode_decimal: 60927
	},
	{
		icon_id: "45682176",
		name: "Rotate cw-xs",
		font_class: "a-Rotatecw-xs",
		unicode: "ee00",
		unicode_decimal: 60928
	},
	{
		icon_id: "45682175",
		name: "Rotate cw-xl",
		font_class: "a-Rotatecw-xl",
		unicode: "ee01",
		unicode_decimal: 60929
	},
	{
		icon_id: "45682186",
		name: "Save-xl",
		font_class: "Save-xl",
		unicode: "edf7",
		unicode_decimal: 60919
	},
	{
		icon_id: "45682185",
		name: "Save-sm",
		font_class: "Save-sm",
		unicode: "edf8",
		unicode_decimal: 60920
	},
	{
		icon_id: "45682184",
		name: "Save-md",
		font_class: "Save-md",
		unicode: "edf9",
		unicode_decimal: 60921
	},
	{
		icon_id: "45682170",
		name: "Rotate ccw-xl",
		font_class: "a-Rotateccw-xl",
		unicode: "edf0",
		unicode_decimal: 60912
	},
	{
		icon_id: "45682169",
		name: "Rotate ccw-sm",
		font_class: "a-Rotateccw-sm",
		unicode: "edf1",
		unicode_decimal: 60913
	},
	{
		icon_id: "45682168",
		name: "Rotate ccw-md",
		font_class: "a-Rotateccw-md",
		unicode: "edf2",
		unicode_decimal: 60914
	},
	{
		icon_id: "45682167",
		name: "Rotate ccw-lg",
		font_class: "a-Rotateccw-lg",
		unicode: "edf3",
		unicode_decimal: 60915
	},
	{
		icon_id: "45682166",
		name: "Rewind-xs",
		font_class: "Rewind-xs",
		unicode: "edf4",
		unicode_decimal: 60916
	},
	{
		icon_id: "45682165",
		name: "Rewind-xl",
		font_class: "Rewind-xl",
		unicode: "edf5",
		unicode_decimal: 60917
	},
	{
		icon_id: "45682164",
		name: "Rewind-sm",
		font_class: "Rewind-sm",
		unicode: "edf6",
		unicode_decimal: 60918
	},
	{
		icon_id: "45682174",
		name: "Rotate cw-sm",
		font_class: "a-Rotatecw-sm",
		unicode: "edec",
		unicode_decimal: 60908
	},
	{
		icon_id: "45682173",
		name: "Rotate cw-md",
		font_class: "a-Rotatecw-md",
		unicode: "eded",
		unicode_decimal: 60909
	},
	{
		icon_id: "45682172",
		name: "Rotate cw-lg",
		font_class: "a-Rotatecw-lg",
		unicode: "edee",
		unicode_decimal: 60910
	},
	{
		icon_id: "45682171",
		name: "Rotate ccw-xs",
		font_class: "a-Rotateccw-xs",
		unicode: "edef",
		unicode_decimal: 60911
	},
	{
		icon_id: "45682159",
		name: "Repeat-sm",
		font_class: "Repeat-sm",
		unicode: "ede5",
		unicode_decimal: 60901
	},
	{
		icon_id: "45682158",
		name: "Repeat-md",
		font_class: "Repeat-md",
		unicode: "ede6",
		unicode_decimal: 60902
	},
	{
		icon_id: "45682157",
		name: "Repeat-lg",
		font_class: "Repeat-lg",
		unicode: "ede7",
		unicode_decimal: 60903
	},
	{
		icon_id: "45682156",
		name: "Refresh cw-xs",
		font_class: "a-Refreshcw-xs",
		unicode: "ede8",
		unicode_decimal: 60904
	},
	{
		icon_id: "45682155",
		name: "Refresh cw-xl",
		font_class: "a-Refreshcw-xl",
		unicode: "ede9",
		unicode_decimal: 60905
	},
	{
		icon_id: "45682154",
		name: "Refresh cw-sm",
		font_class: "a-Refreshcw-sm",
		unicode: "edea",
		unicode_decimal: 60906
	},
	{
		icon_id: "45682153",
		name: "Refresh cw-md",
		font_class: "a-Refreshcw-md",
		unicode: "edeb",
		unicode_decimal: 60907
	},
	{
		icon_id: "45682163",
		name: "Rewind-md",
		font_class: "Rewind-md",
		unicode: "ede1",
		unicode_decimal: 60897
	},
	{
		icon_id: "45682162",
		name: "Rewind-lg",
		font_class: "Rewind-lg",
		unicode: "ede2",
		unicode_decimal: 60898
	},
	{
		icon_id: "45682161",
		name: "Repeat-xs",
		font_class: "Repeat-xs",
		unicode: "ede3",
		unicode_decimal: 60899
	},
	{
		icon_id: "45682160",
		name: "Repeat-xl",
		font_class: "Repeat-xl",
		unicode: "ede4",
		unicode_decimal: 60900
	},
	{
		icon_id: "45682149",
		name: "Refresh ccw-sm",
		font_class: "a-Refreshccw-sm",
		unicode: "edd9",
		unicode_decimal: 60889
	},
	{
		icon_id: "45682148",
		name: "Refresh ccw-md",
		font_class: "a-Refreshccw-md",
		unicode: "edda",
		unicode_decimal: 60890
	},
	{
		icon_id: "45682147",
		name: "Refresh ccw-lg",
		font_class: "a-Refreshccw-lg",
		unicode: "eddb",
		unicode_decimal: 60891
	},
	{
		icon_id: "45682146",
		name: "Radio-xs",
		font_class: "Radio-xs",
		unicode: "eddc",
		unicode_decimal: 60892
	},
	{
		icon_id: "45682145",
		name: "Radio-xl",
		font_class: "Radio-xl",
		unicode: "eddd",
		unicode_decimal: 60893
	},
	{
		icon_id: "45682144",
		name: "Radio-sm",
		font_class: "Radio-sm",
		unicode: "edde",
		unicode_decimal: 60894
	},
	{
		icon_id: "45682143",
		name: "Radio-md",
		font_class: "Radio-md",
		unicode: "eddf",
		unicode_decimal: 60895
	},
	{
		icon_id: "45682142",
		name: "Radio-lg",
		font_class: "Radio-lg",
		unicode: "ede0",
		unicode_decimal: 60896
	},
	{
		icon_id: "45682152",
		name: "Refresh cw-lg",
		font_class: "a-Refreshcw-lg",
		unicode: "edd6",
		unicode_decimal: 60886
	},
	{
		icon_id: "45682151",
		name: "Refresh ccw-xs",
		font_class: "a-Refreshccw-xs",
		unicode: "edd7",
		unicode_decimal: 60887
	},
	{
		icon_id: "45682150",
		name: "Refresh ccw-xl",
		font_class: "a-Refreshccw-xl",
		unicode: "edd8",
		unicode_decimal: 60888
	},
	{
		icon_id: "45682129",
		name: "Python-lg",
		font_class: "Python-lg",
		unicode: "edd5",
		unicode_decimal: 60885
	},
	{
		icon_id: "45682135",
		name: "R-Sidebar-md",
		font_class: "R-Sidebar-md",
		unicode: "edcf",
		unicode_decimal: 60879
	},
	{
		icon_id: "45682134",
		name: "R-Sidebar-lg",
		font_class: "R-Sidebar-lg",
		unicode: "edd0",
		unicode_decimal: 60880
	},
	{
		icon_id: "45682133",
		name: "Python-xs",
		font_class: "Python-xs",
		unicode: "edd1",
		unicode_decimal: 60881
	},
	{
		icon_id: "45682132",
		name: "Python-xl",
		font_class: "Python-xl",
		unicode: "edd2",
		unicode_decimal: 60882
	},
	{
		icon_id: "45682131",
		name: "Python-sm",
		font_class: "Python-sm",
		unicode: "edd3",
		unicode_decimal: 60883
	},
	{
		icon_id: "45682130",
		name: "Python-md",
		font_class: "Python-md",
		unicode: "edd4",
		unicode_decimal: 60884
	},
	{
		icon_id: "45682140",
		name: "R-Sidebar-xs",
		font_class: "R-Sidebar-xs",
		unicode: "edcc",
		unicode_decimal: 60876
	},
	{
		icon_id: "45682139",
		name: "R-Sidebar-xl",
		font_class: "R-Sidebar-xl",
		unicode: "edcd",
		unicode_decimal: 60877
	},
	{
		icon_id: "45682137",
		name: "R-Sidebar-sm",
		font_class: "R-Sidebar-sm",
		unicode: "edce",
		unicode_decimal: 60878
	},
	{
		icon_id: "45682123",
		name: "Printer-lg",
		font_class: "Printer-lg",
		unicode: "edc6",
		unicode_decimal: 60870
	},
	{
		icon_id: "45682122",
		name: "Power-xs",
		font_class: "Power-xs",
		unicode: "edc7",
		unicode_decimal: 60871
	},
	{
		icon_id: "45682121",
		name: "Power-xl",
		font_class: "Power-xl",
		unicode: "edc8",
		unicode_decimal: 60872
	},
	{
		icon_id: "45682120",
		name: "Power-sm",
		font_class: "Power-sm",
		unicode: "edc9",
		unicode_decimal: 60873
	},
	{
		icon_id: "45682116",
		name: "Power-md",
		font_class: "Power-md",
		unicode: "edca",
		unicode_decimal: 60874
	},
	{
		icon_id: "45682115",
		name: "Power-lg",
		font_class: "Power-lg",
		unicode: "edcb",
		unicode_decimal: 60875
	},
	{
		icon_id: "45682127",
		name: "Printer-xs",
		font_class: "Printer-xs",
		unicode: "edc2",
		unicode_decimal: 60866
	},
	{
		icon_id: "45682126",
		name: "Printer-xl",
		font_class: "Printer-xl",
		unicode: "edc3",
		unicode_decimal: 60867
	},
	{
		icon_id: "45682125",
		name: "Printer-sm",
		font_class: "Printer-sm",
		unicode: "edc4",
		unicode_decimal: 60868
	},
	{
		icon_id: "45682124",
		name: "Printer-md",
		font_class: "Printer-md",
		unicode: "edc5",
		unicode_decimal: 60869
	},
	{
		icon_id: "45682111",
		name: "Pocket-md",
		font_class: "Pocket-md",
		unicode: "edba",
		unicode_decimal: 60858
	},
	{
		icon_id: "45682110",
		name: "Pocket-lg",
		font_class: "Pocket-lg",
		unicode: "edbb",
		unicode_decimal: 60859
	},
	{
		icon_id: "45682109",
		name: "Plus square-xs",
		font_class: "a-Plussquare-xs",
		unicode: "edbc",
		unicode_decimal: 60860
	},
	{
		icon_id: "45682108",
		name: "Plus square-xl",
		font_class: "a-Plussquare-xl",
		unicode: "edbd",
		unicode_decimal: 60861
	},
	{
		icon_id: "45682107",
		name: "Plus square-sm",
		font_class: "a-Plussquare-sm",
		unicode: "edbe",
		unicode_decimal: 60862
	},
	{
		icon_id: "45682106",
		name: "Plus square-md",
		font_class: "a-Plussquare-md",
		unicode: "edbf",
		unicode_decimal: 60863
	},
	{
		icon_id: "45682105",
		name: "Plus square-lg",
		font_class: "a-Plussquare-lg",
		unicode: "edc0",
		unicode_decimal: 60864
	},
	{
		icon_id: "45682104",
		name: "Plus circle-xs",
		font_class: "a-Pluscircle-xs",
		unicode: "edc1",
		unicode_decimal: 60865
	},
	{
		icon_id: "45682114",
		name: "Pocket-xs",
		font_class: "Pocket-xs",
		unicode: "edb7",
		unicode_decimal: 60855
	},
	{
		icon_id: "45682113",
		name: "Pocket-xl",
		font_class: "Pocket-xl",
		unicode: "edb8",
		unicode_decimal: 60856
	},
	{
		icon_id: "45682112",
		name: "Pocket-sm",
		font_class: "Pocket-sm",
		unicode: "edb9",
		unicode_decimal: 60857
	},
	{
		icon_id: "45682098",
		name: "Plus-xs",
		font_class: "Plus-xs",
		unicode: "edaf",
		unicode_decimal: 60847
	},
	{
		icon_id: "45682097",
		name: "Plus-xl",
		font_class: "Plus-xl",
		unicode: "edb0",
		unicode_decimal: 60848
	},
	{
		icon_id: "45682096",
		name: "Plus-sm",
		font_class: "Plus-sm",
		unicode: "edb1",
		unicode_decimal: 60849
	},
	{
		icon_id: "45682095",
		name: "Plus-md",
		font_class: "Plus-md",
		unicode: "edb2",
		unicode_decimal: 60850
	},
	{
		icon_id: "45682094",
		name: "Plus-lg",
		font_class: "Plus-lg",
		unicode: "edb3",
		unicode_decimal: 60851
	},
	{
		icon_id: "45682093",
		name: "Play circle-xs",
		font_class: "a-Playcircle-xs",
		unicode: "edb4",
		unicode_decimal: 60852
	},
	{
		icon_id: "45682092",
		name: "Play circle-xl",
		font_class: "a-Playcircle-xl",
		unicode: "edb5",
		unicode_decimal: 60853
	},
	{
		icon_id: "45682091",
		name: "Play circle-sm",
		font_class: "a-Playcircle-sm",
		unicode: "edb6",
		unicode_decimal: 60854
	},
	{
		icon_id: "45682103",
		name: "Plus circle-xl",
		font_class: "a-Pluscircle-xl",
		unicode: "edab",
		unicode_decimal: 60843
	},
	{
		icon_id: "45682102",
		name: "Plus circle-sm",
		font_class: "a-Pluscircle-sm",
		unicode: "edac",
		unicode_decimal: 60844
	},
	{
		icon_id: "45682101",
		name: "Plus circle-md",
		font_class: "a-Pluscircle-md",
		unicode: "edad",
		unicode_decimal: 60845
	},
	{
		icon_id: "45682099",
		name: "Plus circle-lg",
		font_class: "a-Pluscircle-lg",
		unicode: "edae",
		unicode_decimal: 60846
	},
	{
		icon_id: "45682085",
		name: "Play-md",
		font_class: "Play-md",
		unicode: "eda5",
		unicode_decimal: 60837
	},
	{
		icon_id: "45682084",
		name: "Play-lg",
		font_class: "Play-lg",
		unicode: "eda6",
		unicode_decimal: 60838
	},
	{
		icon_id: "45682083",
		name: "Pie chart-xs",
		font_class: "a-Piechart-xs",
		unicode: "eda7",
		unicode_decimal: 60839
	},
	{
		icon_id: "45682082",
		name: "Pie chart-xl",
		font_class: "a-Piechart-xl",
		unicode: "eda8",
		unicode_decimal: 60840
	},
	{
		icon_id: "45682081",
		name: "Pie chart-sm",
		font_class: "a-Piechart-sm",
		unicode: "eda9",
		unicode_decimal: 60841
	},
	{
		icon_id: "45682080",
		name: "Pie chart-md",
		font_class: "a-Piechart-md",
		unicode: "edaa",
		unicode_decimal: 60842
	},
	{
		icon_id: "45682090",
		name: "Play circle-md",
		font_class: "a-Playcircle-md",
		unicode: "eda0",
		unicode_decimal: 60832
	},
	{
		icon_id: "45682089",
		name: "Play circle-lg",
		font_class: "a-Playcircle-lg",
		unicode: "eda1",
		unicode_decimal: 60833
	},
	{
		icon_id: "45682088",
		name: "Play-xs",
		font_class: "Play-xs",
		unicode: "eda2",
		unicode_decimal: 60834
	},
	{
		icon_id: "45682087",
		name: "Play-xl",
		font_class: "Play-xl",
		unicode: "eda3",
		unicode_decimal: 60835
	},
	{
		icon_id: "45682086",
		name: "Play-sm",
		font_class: "Play-sm",
		unicode: "eda4",
		unicode_decimal: 60836
	},
	{
		icon_id: "45682074",
		name: "Phone outgoing-lg",
		font_class: "a-Phoneoutgoing-lg",
		unicode: "ed9a",
		unicode_decimal: 60826
	},
	{
		icon_id: "45682072",
		name: "Phone off-xs",
		font_class: "a-Phoneoff-xs",
		unicode: "ed9b",
		unicode_decimal: 60827
	},
	{
		icon_id: "45682071",
		name: "Phone off-xl",
		font_class: "a-Phoneoff-xl",
		unicode: "ed9c",
		unicode_decimal: 60828
	},
	{
		icon_id: "45682070",
		name: "Phone off-sm",
		font_class: "a-Phoneoff-sm",
		unicode: "ed9d",
		unicode_decimal: 60829
	},
	{
		icon_id: "45682069",
		name: "Phone off-md",
		font_class: "a-Phoneoff-md",
		unicode: "ed9e",
		unicode_decimal: 60830
	},
	{
		icon_id: "45682068",
		name: "Phone off-lg",
		font_class: "a-Phoneoff-lg",
		unicode: "ed9f",
		unicode_decimal: 60831
	},
	{
		icon_id: "45682079",
		name: "Pie chart-lg",
		font_class: "a-Piechart-lg",
		unicode: "ed95",
		unicode_decimal: 60821
	},
	{
		icon_id: "45682078",
		name: "Phone outgoing-xs",
		font_class: "a-Phoneoutgoing-xs",
		unicode: "ed96",
		unicode_decimal: 60822
	},
	{
		icon_id: "45682077",
		name: "Phone outgoing-xl",
		font_class: "a-Phoneoutgoing-xl",
		unicode: "ed97",
		unicode_decimal: 60823
	},
	{
		icon_id: "45682076",
		name: "Phone outgoing-sm",
		font_class: "a-Phoneoutgoing-sm",
		unicode: "ed98",
		unicode_decimal: 60824
	},
	{
		icon_id: "45682075",
		name: "Phone outgoing-md",
		font_class: "a-Phoneoutgoing-md",
		unicode: "ed99",
		unicode_decimal: 60825
	},
	{
		icon_id: "45682060",
		name: "Phone incoming-xl",
		font_class: "a-Phoneincoming-xl",
		unicode: "ed91",
		unicode_decimal: 60817
	},
	{
		icon_id: "45682059",
		name: "Phone incoming-sm",
		font_class: "a-Phoneincoming-sm",
		unicode: "ed92",
		unicode_decimal: 60818
	},
	{
		icon_id: "45682058",
		name: "Phone incoming-md",
		font_class: "a-Phoneincoming-md",
		unicode: "ed93",
		unicode_decimal: 60819
	},
	{
		icon_id: "45682057",
		name: "Phone incoming-lg",
		font_class: "a-Phoneincoming-lg",
		unicode: "ed94",
		unicode_decimal: 60820
	},
	{
		icon_id: "45682067",
		name: "Phone missed-xs",
		font_class: "a-Phonemissed-xs",
		unicode: "ed8b",
		unicode_decimal: 60811
	},
	{
		icon_id: "45682066",
		name: "Phone missed-xl",
		font_class: "a-Phonemissed-xl",
		unicode: "ed8c",
		unicode_decimal: 60812
	},
	{
		icon_id: "45682065",
		name: "Phone missed-sm",
		font_class: "a-Phonemissed-sm",
		unicode: "ed8d",
		unicode_decimal: 60813
	},
	{
		icon_id: "45682064",
		name: "Phone missed-md",
		font_class: "a-Phonemissed-md",
		unicode: "ed8e",
		unicode_decimal: 60814
	},
	{
		icon_id: "45682063",
		name: "Phone missed-lg",
		font_class: "a-Phonemissed-lg",
		unicode: "ed8f",
		unicode_decimal: 60815
	},
	{
		icon_id: "45682061",
		name: "Phone incoming-xs",
		font_class: "a-Phoneincoming-xs",
		unicode: "ed90",
		unicode_decimal: 60816
	},
	{
		icon_id: "45682051",
		name: "Phone call-xs",
		font_class: "a-Phonecall-xs",
		unicode: "ed86",
		unicode_decimal: 60806
	},
	{
		icon_id: "45682049",
		name: "Phone call-xl",
		font_class: "a-Phonecall-xl",
		unicode: "ed87",
		unicode_decimal: 60807
	},
	{
		icon_id: "45682048",
		name: "Phone call-sm",
		font_class: "a-Phonecall-sm",
		unicode: "ed88",
		unicode_decimal: 60808
	},
	{
		icon_id: "45682047",
		name: "Phone call-md",
		font_class: "a-Phonecall-md",
		unicode: "ed89",
		unicode_decimal: 60809
	},
	{
		icon_id: "45682046",
		name: "Phone call-lg",
		font_class: "a-Phonecall-lg",
		unicode: "ed8a",
		unicode_decimal: 60810
	},
	{
		icon_id: "45682056",
		name: "Phone forwarded-xs",
		font_class: "a-Phoneforwarded-xs",
		unicode: "ed81",
		unicode_decimal: 60801
	},
	{
		icon_id: "45682055",
		name: "Phone forwarded-xl",
		font_class: "a-Phoneforwarded-xl",
		unicode: "ed82",
		unicode_decimal: 60802
	},
	{
		icon_id: "45682054",
		name: "Phone forwarded-sm",
		font_class: "a-Phoneforwarded-sm",
		unicode: "ed83",
		unicode_decimal: 60803
	},
	{
		icon_id: "45682053",
		name: "Phone forwarded-md",
		font_class: "a-Phoneforwarded-md",
		unicode: "ed84",
		unicode_decimal: 60804
	},
	{
		icon_id: "45682052",
		name: "Phone forwarded-lg",
		font_class: "a-Phoneforwarded-lg",
		unicode: "ed85",
		unicode_decimal: 60805
	},
	{
		icon_id: "45682039",
		name: "Percent-xl",
		font_class: "Percent-xl",
		unicode: "ed7c",
		unicode_decimal: 60796
	},
	{
		icon_id: "45682038",
		name: "Percent-sm",
		font_class: "Percent-sm",
		unicode: "ed7d",
		unicode_decimal: 60797
	},
	{
		icon_id: "45682037",
		name: "Percent-md",
		font_class: "Percent-md",
		unicode: "ed7e",
		unicode_decimal: 60798
	},
	{
		icon_id: "45682036",
		name: "Percent-lg",
		font_class: "Percent-lg",
		unicode: "ed7f",
		unicode_decimal: 60799
	},
	{
		icon_id: "45682035",
		name: "Pen tool-xs",
		font_class: "a-Pentool-xs",
		unicode: "ed80",
		unicode_decimal: 60800
	},
	{
		icon_id: "45682045",
		name: "Phone-xs",
		font_class: "Phone-xs",
		unicode: "ed76",
		unicode_decimal: 60790
	},
	{
		icon_id: "45682044",
		name: "Phone-xl",
		font_class: "Phone-xl",
		unicode: "ed77",
		unicode_decimal: 60791
	},
	{
		icon_id: "45682043",
		name: "Phone-sm",
		font_class: "Phone-sm",
		unicode: "ed78",
		unicode_decimal: 60792
	},
	{
		icon_id: "45682042",
		name: "Phone-md",
		font_class: "Phone-md",
		unicode: "ed79",
		unicode_decimal: 60793
	},
	{
		icon_id: "45682041",
		name: "Phone-lg",
		font_class: "Phone-lg",
		unicode: "ed7a",
		unicode_decimal: 60794
	},
	{
		icon_id: "45682040",
		name: "Percent-xs",
		font_class: "Percent-xs",
		unicode: "ed7b",
		unicode_decimal: 60795
	},
	{
		icon_id: "45682026",
		name: "Pause circle-lg",
		font_class: "a-Pausecircle-lg",
		unicode: "ed74",
		unicode_decimal: 60788
	},
	{
		icon_id: "45682025",
		name: "Pause-xs",
		font_class: "Pause-xs",
		unicode: "ed75",
		unicode_decimal: 60789
	},
	{
		icon_id: "45682034",
		name: "Pen tool-xl",
		font_class: "a-Pentool-xl",
		unicode: "ed6c",
		unicode_decimal: 60780
	},
	{
		icon_id: "45682033",
		name: "Pen tool-sm",
		font_class: "a-Pentool-sm",
		unicode: "ed6d",
		unicode_decimal: 60781
	},
	{
		icon_id: "45682032",
		name: "Pen tool-md",
		font_class: "a-Pentool-md",
		unicode: "ed6e",
		unicode_decimal: 60782
	},
	{
		icon_id: "45682031",
		name: "Pen tool-lg",
		font_class: "a-Pentool-lg",
		unicode: "ed6f",
		unicode_decimal: 60783
	},
	{
		icon_id: "45682030",
		name: "Pause circle-xs",
		font_class: "a-Pausecircle-xs",
		unicode: "ed70",
		unicode_decimal: 60784
	},
	{
		icon_id: "45682029",
		name: "Pause circle-xl",
		font_class: "a-Pausecircle-xl",
		unicode: "ed71",
		unicode_decimal: 60785
	},
	{
		icon_id: "45682028",
		name: "Pause circle-sm",
		font_class: "a-Pausecircle-sm",
		unicode: "ed72",
		unicode_decimal: 60786
	},
	{
		icon_id: "45682027",
		name: "Pause circle-md",
		font_class: "a-Pausecircle-md",
		unicode: "ed73",
		unicode_decimal: 60787
	},
	{
		icon_id: "45682016",
		name: "Paperclip-lg",
		font_class: "Paperclip-lg",
		unicode: "ed68",
		unicode_decimal: 60776
	},
	{
		icon_id: "45682014",
		name: "Package-xs",
		font_class: "Package-xs",
		unicode: "ed69",
		unicode_decimal: 60777
	},
	{
		icon_id: "45682013",
		name: "Package-xl",
		font_class: "Package-xl",
		unicode: "ed6a",
		unicode_decimal: 60778
	},
	{
		icon_id: "45682012",
		name: "Package-sm",
		font_class: "Package-sm",
		unicode: "ed6b",
		unicode_decimal: 60779
	},
	{
		icon_id: "45682017",
		name: "Paperclip-md",
		font_class: "Paperclip-md",
		unicode: "ed67",
		unicode_decimal: 60775
	},
	{
		icon_id: "45682024",
		name: "Pause-xl",
		font_class: "Pause-xl",
		unicode: "ed60",
		unicode_decimal: 60768
	},
	{
		icon_id: "45682023",
		name: "Pause-sm",
		font_class: "Pause-sm",
		unicode: "ed61",
		unicode_decimal: 60769
	},
	{
		icon_id: "45682022",
		name: "Pause-md",
		font_class: "Pause-md",
		unicode: "ed62",
		unicode_decimal: 60770
	},
	{
		icon_id: "45682021",
		name: "Pause-lg",
		font_class: "Pause-lg",
		unicode: "ed63",
		unicode_decimal: 60771
	},
	{
		icon_id: "45682020",
		name: "Paperclip-xs",
		font_class: "Paperclip-xs",
		unicode: "ed64",
		unicode_decimal: 60772
	},
	{
		icon_id: "45682019",
		name: "Paperclip-xl",
		font_class: "Paperclip-xl",
		unicode: "ed65",
		unicode_decimal: 60773
	},
	{
		icon_id: "45682018",
		name: "Paperclip-sm",
		font_class: "Paperclip-sm",
		unicode: "ed66",
		unicode_decimal: 60774
	},
	{
		icon_id: "45682003",
		name: "Octagon-xl",
		font_class: "Octagon-xl",
		unicode: "ed5d",
		unicode_decimal: 60765
	},
	{
		icon_id: "45682002",
		name: "Octagon-sm",
		font_class: "Octagon-sm",
		unicode: "ed5e",
		unicode_decimal: 60766
	},
	{
		icon_id: "45682001",
		name: "Octagon-md",
		font_class: "Octagon-md",
		unicode: "ed5f",
		unicode_decimal: 60767
	},
	{
		icon_id: "45682011",
		name: "Package-md",
		font_class: "Package-md",
		unicode: "ed55",
		unicode_decimal: 60757
	},
	{
		icon_id: "45682010",
		name: "Package-lg",
		font_class: "Package-lg",
		unicode: "ed56",
		unicode_decimal: 60758
	},
	{
		icon_id: "45682009",
		name: "Option-xs",
		font_class: "Option-xs",
		unicode: "ed57",
		unicode_decimal: 60759
	},
	{
		icon_id: "45682008",
		name: "Option-xl",
		font_class: "Option-xl",
		unicode: "ed58",
		unicode_decimal: 60760
	},
	{
		icon_id: "45682007",
		name: "Option-sm",
		font_class: "Option-sm",
		unicode: "ed59",
		unicode_decimal: 60761
	},
	{
		icon_id: "45682006",
		name: "Option-md",
		font_class: "Option-md",
		unicode: "ed5a",
		unicode_decimal: 60762
	},
	{
		icon_id: "45682005",
		name: "Option-lg",
		font_class: "Option-lg",
		unicode: "ed5b",
		unicode_decimal: 60763
	},
	{
		icon_id: "45682004",
		name: "Octagon-xs",
		font_class: "Octagon-xs",
		unicode: "ed5c",
		unicode_decimal: 60764
	},
	{
		icon_id: "45681991",
		name: "Navigation2-xl",
		font_class: "Navigation2-xl",
		unicode: "ed51",
		unicode_decimal: 60753
	},
	{
		icon_id: "45681990",
		name: "Navigation2-sm",
		font_class: "Navigation2-sm",
		unicode: "ed52",
		unicode_decimal: 60754
	},
	{
		icon_id: "45681989",
		name: "Navigation2-md",
		font_class: "Navigation2-md",
		unicode: "ed53",
		unicode_decimal: 60755
	},
	{
		icon_id: "45681988",
		name: "Navigation2-lg",
		font_class: "Navigation2-lg",
		unicode: "ed54",
		unicode_decimal: 60756
	},
	{
		icon_id: "45682000",
		name: "Octagon-lg",
		font_class: "Octagon-lg",
		unicode: "ed4a",
		unicode_decimal: 60746
	},
	{
		icon_id: "45681998",
		name: "OCR-xs",
		font_class: "OCR-xs",
		unicode: "ed4b",
		unicode_decimal: 60747
	},
	{
		icon_id: "45681997",
		name: "OCR-xl",
		font_class: "OCR-xl",
		unicode: "ed4c",
		unicode_decimal: 60748
	},
	{
		icon_id: "45681996",
		name: "OCR-sm",
		font_class: "OCR-sm",
		unicode: "ed4d",
		unicode_decimal: 60749
	},
	{
		icon_id: "45681995",
		name: "OCR-md",
		font_class: "OCR-md",
		unicode: "ed4e",
		unicode_decimal: 60750
	},
	{
		icon_id: "45681994",
		name: "OCR-lg",
		font_class: "OCR-lg",
		unicode: "ed4f",
		unicode_decimal: 60751
	},
	{
		icon_id: "45681993",
		name: "Navigation2-xs",
		font_class: "Navigation2-xs",
		unicode: "ed50",
		unicode_decimal: 60752
	},
	{
		icon_id: "45681978",
		name: "Nail-lg",
		font_class: "Nail-lg",
		unicode: "ed49",
		unicode_decimal: 60745
	},
	{
		icon_id: "45681987",
		name: "Navigation-xs",
		font_class: "Navigation-xs",
		unicode: "ed40",
		unicode_decimal: 60736
	},
	{
		icon_id: "45681986",
		name: "Navigation-xl",
		font_class: "Navigation-xl",
		unicode: "ed41",
		unicode_decimal: 60737
	},
	{
		icon_id: "45681985",
		name: "Navigation-sm",
		font_class: "Navigation-sm",
		unicode: "ed42",
		unicode_decimal: 60738
	},
	{
		icon_id: "45681984",
		name: "Navigation-md",
		font_class: "Navigation-md",
		unicode: "ed43",
		unicode_decimal: 60739
	},
	{
		icon_id: "45681983",
		name: "Navigation-lg",
		font_class: "Navigation-lg",
		unicode: "ed44",
		unicode_decimal: 60740
	},
	{
		icon_id: "45681982",
		name: "Nail-xs",
		font_class: "Nail-xs",
		unicode: "ed45",
		unicode_decimal: 60741
	},
	{
		icon_id: "45681981",
		name: "Nail-xl",
		font_class: "Nail-xl",
		unicode: "ed46",
		unicode_decimal: 60742
	},
	{
		icon_id: "45681980",
		name: "Nail-sm",
		font_class: "Nail-sm",
		unicode: "ed47",
		unicode_decimal: 60743
	},
	{
		icon_id: "45681979",
		name: "Nail-md",
		font_class: "Nail-md",
		unicode: "ed48",
		unicode_decimal: 60744
	},
	{
		icon_id: "45681977",
		name: "Music-xs",
		font_class: "Music-xs",
		unicode: "ed35",
		unicode_decimal: 60725
	},
	{
		icon_id: "45681976",
		name: "Music-xl",
		font_class: "Music-xl",
		unicode: "ed36",
		unicode_decimal: 60726
	},
	{
		icon_id: "45681975",
		name: "Music-sm",
		font_class: "Music-sm",
		unicode: "ed37",
		unicode_decimal: 60727
	},
	{
		icon_id: "45681974",
		name: "Music-md",
		font_class: "Music-md",
		unicode: "ed38",
		unicode_decimal: 60728
	},
	{
		icon_id: "45681973",
		name: "Music-lg",
		font_class: "Music-lg",
		unicode: "ed39",
		unicode_decimal: 60729
	},
	{
		icon_id: "45681972",
		name: "Move-xs",
		font_class: "Move-xs",
		unicode: "ed3a",
		unicode_decimal: 60730
	},
	{
		icon_id: "45681971",
		name: "Move-xl",
		font_class: "Move-xl",
		unicode: "ed3b",
		unicode_decimal: 60731
	},
	{
		icon_id: "45681970",
		name: "Move-sm",
		font_class: "Move-sm",
		unicode: "ed3c",
		unicode_decimal: 60732
	},
	{
		icon_id: "45681969",
		name: "Move-md",
		font_class: "Move-md",
		unicode: "ed3d",
		unicode_decimal: 60733
	},
	{
		icon_id: "45681968",
		name: "Move-lg",
		font_class: "Move-lg",
		unicode: "ed3e",
		unicode_decimal: 60734
	},
	{
		icon_id: "45681967",
		name: "Mouse pointer-xs",
		font_class: "a-Mousepointer-xs",
		unicode: "ed3f",
		unicode_decimal: 60735
	},
	{
		icon_id: "45681966",
		name: "Mouse pointer-xl",
		font_class: "a-Mousepointer-xl",
		unicode: "ed2b",
		unicode_decimal: 60715
	},
	{
		icon_id: "45681965",
		name: "Mouse pointer-sm",
		font_class: "a-Mousepointer-sm",
		unicode: "ed2c",
		unicode_decimal: 60716
	},
	{
		icon_id: "45681964",
		name: "Mouse pointer-md",
		font_class: "a-Mousepointer-md",
		unicode: "ed2d",
		unicode_decimal: 60717
	},
	{
		icon_id: "45681963",
		name: "Mouse pointer-lg",
		font_class: "a-Mousepointer-lg",
		unicode: "ed2e",
		unicode_decimal: 60718
	},
	{
		icon_id: "45681962",
		name: "More vertical-xs",
		font_class: "a-Morevertical-xs",
		unicode: "ed2f",
		unicode_decimal: 60719
	},
	{
		icon_id: "45681961",
		name: "More vertical-xl",
		font_class: "a-Morevertical-xl",
		unicode: "ed30",
		unicode_decimal: 60720
	},
	{
		icon_id: "45681958",
		name: "More vertical-sm",
		font_class: "a-Morevertical-sm",
		unicode: "ed31",
		unicode_decimal: 60721
	},
	{
		icon_id: "45681957",
		name: "More vertical-md",
		font_class: "a-Morevertical-md",
		unicode: "ed32",
		unicode_decimal: 60722
	},
	{
		icon_id: "45681956",
		name: "More vertical-lg",
		font_class: "a-Morevertical-lg",
		unicode: "ed33",
		unicode_decimal: 60723
	},
	{
		icon_id: "45681954",
		name: "More horizontal-xs",
		font_class: "a-Morehorizontal-xs",
		unicode: "ed34",
		unicode_decimal: 60724
	},
	{
		icon_id: "45681953",
		name: "More horizontal-xl",
		font_class: "a-Morehorizontal-xl",
		unicode: "ed20",
		unicode_decimal: 60704
	},
	{
		icon_id: "45681952",
		name: "More horizontal-sm",
		font_class: "a-Morehorizontal-sm",
		unicode: "ed21",
		unicode_decimal: 60705
	},
	{
		icon_id: "45681951",
		name: "More horizontal-md",
		font_class: "a-Morehorizontal-md",
		unicode: "ed22",
		unicode_decimal: 60706
	},
	{
		icon_id: "45681950",
		name: "More horizontal-lg",
		font_class: "a-Morehorizontal-lg",
		unicode: "ed23",
		unicode_decimal: 60707
	},
	{
		icon_id: "45681949",
		name: "Moon-xs",
		font_class: "Moon-xs",
		unicode: "ed24",
		unicode_decimal: 60708
	},
	{
		icon_id: "45681948",
		name: "Moon-xl",
		font_class: "Moon-xl",
		unicode: "ed25",
		unicode_decimal: 60709
	},
	{
		icon_id: "45681947",
		name: "Moon-sm",
		font_class: "Moon-sm",
		unicode: "ed26",
		unicode_decimal: 60710
	},
	{
		icon_id: "45681946",
		name: "Moon-md",
		font_class: "Moon-md",
		unicode: "ed27",
		unicode_decimal: 60711
	},
	{
		icon_id: "45681945",
		name: "Moon-lg",
		font_class: "Moon-lg",
		unicode: "ed28",
		unicode_decimal: 60712
	},
	{
		icon_id: "45681944",
		name: "Monitor-xs",
		font_class: "Monitor-xs",
		unicode: "ed29",
		unicode_decimal: 60713
	},
	{
		icon_id: "45681943",
		name: "Monitor-xl",
		font_class: "Monitor-xl",
		unicode: "ed2a",
		unicode_decimal: 60714
	},
	{
		icon_id: "45681942",
		name: "Monitor-sm",
		font_class: "Monitor-sm",
		unicode: "ed15",
		unicode_decimal: 60693
	},
	{
		icon_id: "45681941",
		name: "Monitor-md",
		font_class: "Monitor-md",
		unicode: "ed16",
		unicode_decimal: 60694
	},
	{
		icon_id: "45681940",
		name: "Monitor-lg",
		font_class: "Monitor-lg",
		unicode: "ed17",
		unicode_decimal: 60695
	},
	{
		icon_id: "45681939",
		name: "Minus square-xs",
		font_class: "a-Minussquare-xs",
		unicode: "ed18",
		unicode_decimal: 60696
	},
	{
		icon_id: "45681938",
		name: "Minus square-xl",
		font_class: "a-Minussquare-xl",
		unicode: "ed19",
		unicode_decimal: 60697
	},
	{
		icon_id: "45681937",
		name: "Minus square-sm",
		font_class: "a-Minussquare-sm",
		unicode: "ed1a",
		unicode_decimal: 60698
	},
	{
		icon_id: "45681936",
		name: "Minus square-md",
		font_class: "a-Minussquare-md",
		unicode: "ed1b",
		unicode_decimal: 60699
	},
	{
		icon_id: "45681935",
		name: "Minus square-lg",
		font_class: "a-Minussquare-lg",
		unicode: "ed1c",
		unicode_decimal: 60700
	},
	{
		icon_id: "45681933",
		name: "Minus circle-xs",
		font_class: "a-Minuscircle-xs",
		unicode: "ed1d",
		unicode_decimal: 60701
	},
	{
		icon_id: "45681931",
		name: "Minus circle-xl",
		font_class: "a-Minuscircle-xl",
		unicode: "ed1e",
		unicode_decimal: 60702
	},
	{
		icon_id: "45681930",
		name: "Minus circle-sm",
		font_class: "a-Minuscircle-sm",
		unicode: "ed1f",
		unicode_decimal: 60703
	},
	{
		icon_id: "45681919",
		name: "Minimize2-sm",
		font_class: "Minimize2-sm",
		unicode: "ed12",
		unicode_decimal: 60690
	},
	{
		icon_id: "45681918",
		name: "Minimize2-md",
		font_class: "Minimize2-md",
		unicode: "ed13",
		unicode_decimal: 60691
	},
	{
		icon_id: "45681917",
		name: "Minimize2-lg",
		font_class: "Minimize2-lg",
		unicode: "ed14",
		unicode_decimal: 60692
	},
	{
		icon_id: "45681929",
		name: "Minus circle-md",
		font_class: "a-Minuscircle-md",
		unicode: "ed09",
		unicode_decimal: 60681
	},
	{
		icon_id: "45681928",
		name: "Minus circle-lg",
		font_class: "a-Minuscircle-lg",
		unicode: "ed0a",
		unicode_decimal: 60682
	},
	{
		icon_id: "45681927",
		name: "Minus-xs",
		font_class: "Minus-xs",
		unicode: "ed0b",
		unicode_decimal: 60683
	},
	{
		icon_id: "45681926",
		name: "Minus-xl",
		font_class: "Minus-xl",
		unicode: "ed0c",
		unicode_decimal: 60684
	},
	{
		icon_id: "45681925",
		name: "Minus-sm",
		font_class: "Minus-sm",
		unicode: "ed0d",
		unicode_decimal: 60685
	},
	{
		icon_id: "45681924",
		name: "Minus-md",
		font_class: "Minus-md",
		unicode: "ed0e",
		unicode_decimal: 60686
	},
	{
		icon_id: "45681923",
		name: "Minus-lg",
		font_class: "Minus-lg",
		unicode: "ed0f",
		unicode_decimal: 60687
	},
	{
		icon_id: "45681922",
		name: "Minimize2-xs",
		font_class: "Minimize2-xs",
		unicode: "ed10",
		unicode_decimal: 60688
	},
	{
		icon_id: "45681920",
		name: "Minimize2-xl",
		font_class: "Minimize2-xl",
		unicode: "ed11",
		unicode_decimal: 60689
	},
	{
		icon_id: "45681916",
		name: "Minimize-xs",
		font_class: "Minimize-xs",
		unicode: "ecff",
		unicode_decimal: 60671
	},
	{
		icon_id: "45681915",
		name: "Minimize-xl",
		font_class: "Minimize-xl",
		unicode: "ed00",
		unicode_decimal: 60672
	},
	{
		icon_id: "45681914",
		name: "Minimize-sm",
		font_class: "Minimize-sm",
		unicode: "ed01",
		unicode_decimal: 60673
	},
	{
		icon_id: "45681913",
		name: "Minimize-md",
		font_class: "Minimize-md",
		unicode: "ed02",
		unicode_decimal: 60674
	},
	{
		icon_id: "45681912",
		name: "Minimize-lg",
		font_class: "Minimize-lg",
		unicode: "ed03",
		unicode_decimal: 60675
	},
	{
		icon_id: "45681911",
		name: "Mic off-xs",
		font_class: "a-Micoff-xs",
		unicode: "ed04",
		unicode_decimal: 60676
	},
	{
		icon_id: "45681910",
		name: "Mic off-xl",
		font_class: "a-Micoff-xl",
		unicode: "ed05",
		unicode_decimal: 60677
	},
	{
		icon_id: "45681909",
		name: "Mic off-sm",
		font_class: "a-Micoff-sm",
		unicode: "ed06",
		unicode_decimal: 60678
	},
	{
		icon_id: "45681908",
		name: "Mic off-md",
		font_class: "a-Micoff-md",
		unicode: "ed07",
		unicode_decimal: 60679
	},
	{
		icon_id: "45681907",
		name: "Mic off-lg",
		font_class: "a-Micoff-lg",
		unicode: "ed08",
		unicode_decimal: 60680
	},
	{
		icon_id: "45681906",
		name: "Mic-xs",
		font_class: "Mic-xs",
		unicode: "ecfa",
		unicode_decimal: 60666
	},
	{
		icon_id: "45681905",
		name: "Mic-xl",
		font_class: "Mic-xl",
		unicode: "ecfb",
		unicode_decimal: 60667
	},
	{
		icon_id: "45681904",
		name: "Mic-sm",
		font_class: "Mic-sm",
		unicode: "ecfc",
		unicode_decimal: 60668
	},
	{
		icon_id: "45681903",
		name: "Mic-md",
		font_class: "Mic-md",
		unicode: "ecfd",
		unicode_decimal: 60669
	},
	{
		icon_id: "45681902",
		name: "Mic-lg",
		font_class: "Mic-lg",
		unicode: "ecfe",
		unicode_decimal: 60670
	},
	{
		icon_id: "45681877",
		name: "Meh-xs",
		font_class: "Meh-xs",
		unicode: "ecf9",
		unicode_decimal: 60665
	},
	{
		icon_id: "45681887",
		name: "Message circle-xs",
		font_class: "a-Messagecircle-xs",
		unicode: "ecef",
		unicode_decimal: 60655
	},
	{
		icon_id: "45681886",
		name: "Message circle-xl",
		font_class: "a-Messagecircle-xl",
		unicode: "ecf0",
		unicode_decimal: 60656
	},
	{
		icon_id: "45681885",
		name: "Message circle-sm",
		font_class: "a-Messagecircle-sm",
		unicode: "ecf1",
		unicode_decimal: 60657
	},
	{
		icon_id: "45681884",
		name: "Message circle-md",
		font_class: "a-Messagecircle-md",
		unicode: "ecf2",
		unicode_decimal: 60658
	},
	{
		icon_id: "45681883",
		name: "Message circle-lg",
		font_class: "a-Messagecircle-lg",
		unicode: "ecf3",
		unicode_decimal: 60659
	},
	{
		icon_id: "45681882",
		name: "Menu-xs",
		font_class: "Menu-xs",
		unicode: "ecf4",
		unicode_decimal: 60660
	},
	{
		icon_id: "45681881",
		name: "Menu-xl",
		font_class: "Menu-xl",
		unicode: "ecf5",
		unicode_decimal: 60661
	},
	{
		icon_id: "45681880",
		name: "Menu-sm",
		font_class: "Menu-sm",
		unicode: "ecf6",
		unicode_decimal: 60662
	},
	{
		icon_id: "45681879",
		name: "Menu-md",
		font_class: "Menu-md",
		unicode: "ecf7",
		unicode_decimal: 60663
	},
	{
		icon_id: "45681878",
		name: "Menu-lg",
		font_class: "Menu-lg",
		unicode: "ecf8",
		unicode_decimal: 60664
	},
	{
		icon_id: "45681861",
		name: "Maximize-xs",
		font_class: "Maximize-xs",
		unicode: "eced",
		unicode_decimal: 60653
	},
	{
		icon_id: "45681860",
		name: "Maximize-xl",
		font_class: "Maximize-xl",
		unicode: "ecee",
		unicode_decimal: 60654
	},
	{
		icon_id: "45681876",
		name: "Meh-xl",
		font_class: "Meh-xl",
		unicode: "ece4",
		unicode_decimal: 60644
	},
	{
		icon_id: "45681875",
		name: "Meh-sm",
		font_class: "Meh-sm",
		unicode: "ece5",
		unicode_decimal: 60645
	},
	{
		icon_id: "45681874",
		name: "Meh-md",
		font_class: "Meh-md",
		unicode: "ece6",
		unicode_decimal: 60646
	},
	{
		icon_id: "45681873",
		name: "Meh-lg",
		font_class: "Meh-lg",
		unicode: "ece7",
		unicode_decimal: 60647
	},
	{
		icon_id: "45681871",
		name: "Maximize2-xs",
		font_class: "Maximize2-xs",
		unicode: "ece8",
		unicode_decimal: 60648
	},
	{
		icon_id: "45681869",
		name: "Maximize2-xl",
		font_class: "Maximize2-xl",
		unicode: "ece9",
		unicode_decimal: 60649
	},
	{
		icon_id: "45681868",
		name: "Maximize2-sm",
		font_class: "Maximize2-sm",
		unicode: "ecea",
		unicode_decimal: 60650
	},
	{
		icon_id: "45681867",
		name: "Maximize2-md",
		font_class: "Maximize2-md",
		unicode: "eceb",
		unicode_decimal: 60651
	},
	{
		icon_id: "45681866",
		name: "Maximize2-lg",
		font_class: "Maximize2-lg",
		unicode: "ecec",
		unicode_decimal: 60652
	},
	{
		icon_id: "45681859",
		name: "Maximize-sm",
		font_class: "Maximize-sm",
		unicode: "ecd8",
		unicode_decimal: 60632
	},
	{
		icon_id: "45681858",
		name: "Maximize-md",
		font_class: "Maximize-md",
		unicode: "ecd9",
		unicode_decimal: 60633
	},
	{
		icon_id: "45681857",
		name: "Maximize-lg",
		font_class: "Maximize-lg",
		unicode: "ecda",
		unicode_decimal: 60634
	},
	{
		icon_id: "45681856",
		name: "Map pin-xs",
		font_class: "a-Mappin-xs",
		unicode: "ecdb",
		unicode_decimal: 60635
	},
	{
		icon_id: "45681855",
		name: "Map pin-xl",
		font_class: "a-Mappin-xl",
		unicode: "ecdc",
		unicode_decimal: 60636
	},
	{
		icon_id: "45681854",
		name: "Map pin-sm",
		font_class: "a-Mappin-sm",
		unicode: "ecdd",
		unicode_decimal: 60637
	},
	{
		icon_id: "45681853",
		name: "Map pin-md",
		font_class: "a-Mappin-md",
		unicode: "ecde",
		unicode_decimal: 60638
	},
	{
		icon_id: "45681851",
		name: "Map pin-lg",
		font_class: "a-Mappin-lg",
		unicode: "ecdf",
		unicode_decimal: 60639
	},
	{
		icon_id: "45681850",
		name: "Map-xs",
		font_class: "Map-xs",
		unicode: "ece0",
		unicode_decimal: 60640
	},
	{
		icon_id: "45681849",
		name: "Map-xl",
		font_class: "Map-xl",
		unicode: "ece1",
		unicode_decimal: 60641
	},
	{
		icon_id: "45681848",
		name: "Map-sm",
		font_class: "Map-sm",
		unicode: "ece2",
		unicode_decimal: 60642
	},
	{
		icon_id: "45681847",
		name: "Map-md",
		font_class: "Map-md",
		unicode: "ece3",
		unicode_decimal: 60643
	},
	{
		icon_id: "45681845",
		name: "Mail-xs",
		font_class: "Mail-xs",
		unicode: "ecce",
		unicode_decimal: 60622
	},
	{
		icon_id: "45681844",
		name: "Mail-xl",
		font_class: "Mail-xl",
		unicode: "eccf",
		unicode_decimal: 60623
	},
	{
		icon_id: "45681843",
		name: "Mail-sm",
		font_class: "Mail-sm",
		unicode: "ecd0",
		unicode_decimal: 60624
	},
	{
		icon_id: "45681842",
		name: "Mail-md",
		font_class: "Mail-md",
		unicode: "ecd1",
		unicode_decimal: 60625
	},
	{
		icon_id: "45681841",
		name: "Mail-lg",
		font_class: "Mail-lg",
		unicode: "ecd2",
		unicode_decimal: 60626
	},
	{
		icon_id: "45681840",
		name: "Log out-xs",
		font_class: "a-Logout-xs",
		unicode: "ecd3",
		unicode_decimal: 60627
	},
	{
		icon_id: "45681839",
		name: "Log out-xl",
		font_class: "a-Logout-xl",
		unicode: "ecd4",
		unicode_decimal: 60628
	},
	{
		icon_id: "45681838",
		name: "Log out-sm",
		font_class: "a-Logout-sm",
		unicode: "ecd5",
		unicode_decimal: 60629
	},
	{
		icon_id: "45681837",
		name: "Log out-md",
		font_class: "a-Logout-md",
		unicode: "ecd6",
		unicode_decimal: 60630
	},
	{
		icon_id: "45681836",
		name: "Log out-lg",
		font_class: "a-Logout-lg",
		unicode: "ecd7",
		unicode_decimal: 60631
	},
	{
		icon_id: "45681846",
		name: "Map-lg",
		font_class: "Map-lg",
		unicode: "eccd",
		unicode_decimal: 60621
	},
	{
		icon_id: "45681833",
		name: "Log in-sm",
		font_class: "a-Login-sm",
		unicode: "ecc5",
		unicode_decimal: 60613
	},
	{
		icon_id: "45681832",
		name: "Log in-md",
		font_class: "a-Login-md",
		unicode: "ecc6",
		unicode_decimal: 60614
	},
	{
		icon_id: "45681831",
		name: "Log in-lg",
		font_class: "a-Login-lg",
		unicode: "ecc7",
		unicode_decimal: 60615
	},
	{
		icon_id: "45681830",
		name: "Lock-xs",
		font_class: "Lock-xs",
		unicode: "ecc8",
		unicode_decimal: 60616
	},
	{
		icon_id: "45681829",
		name: "Lock-xl",
		font_class: "Lock-xl",
		unicode: "ecc9",
		unicode_decimal: 60617
	},
	{
		icon_id: "45681828",
		name: "Lock-sm",
		font_class: "Lock-sm",
		unicode: "ecca",
		unicode_decimal: 60618
	},
	{
		icon_id: "45681827",
		name: "Lock-md",
		font_class: "Lock-md",
		unicode: "eccb",
		unicode_decimal: 60619
	},
	{
		icon_id: "45681826",
		name: "Lock-lg",
		font_class: "Lock-lg",
		unicode: "eccc",
		unicode_decimal: 60620
	},
	{
		icon_id: "45681835",
		name: "Log in-xs",
		font_class: "a-Login-xs",
		unicode: "ecc3",
		unicode_decimal: 60611
	},
	{
		icon_id: "45681834",
		name: "Log in-xl",
		font_class: "a-Login-xl",
		unicode: "ecc4",
		unicode_decimal: 60612
	},
	{
		icon_id: "45681823",
		name: "Loader-md",
		font_class: "Loader-md",
		unicode: "ecbb",
		unicode_decimal: 60603
	},
	{
		icon_id: "45681822",
		name: "Loader-lg",
		font_class: "Loader-lg",
		unicode: "ecbc",
		unicode_decimal: 60604
	},
	{
		icon_id: "45681821",
		name: "List-xs",
		font_class: "List-xs",
		unicode: "ecbd",
		unicode_decimal: 60605
	},
	{
		icon_id: "45681820",
		name: "List-xl",
		font_class: "List-xl",
		unicode: "ecbe",
		unicode_decimal: 60606
	},
	{
		icon_id: "45681819",
		name: "List-sm",
		font_class: "List-sm",
		unicode: "ecbf",
		unicode_decimal: 60607
	},
	{
		icon_id: "45681818",
		name: "List-md",
		font_class: "List-md",
		unicode: "ecc0",
		unicode_decimal: 60608
	},
	{
		icon_id: "45681817",
		name: "List-lg",
		font_class: "List-lg",
		unicode: "ecc1",
		unicode_decimal: 60609
	},
	{
		icon_id: "45681816",
		name: "Linkedin-xs",
		font_class: "Linkedin-xs",
		unicode: "ecc2",
		unicode_decimal: 60610
	},
	{
		icon_id: "45681825",
		name: "Loader-xs",
		font_class: "Loader-xs",
		unicode: "ecb9",
		unicode_decimal: 60601
	},
	{
		icon_id: "45681824",
		name: "Loader-xl",
		font_class: "Loader-xl",
		unicode: "ecba",
		unicode_decimal: 60602
	},
	{
		icon_id: "45681813",
		name: "Linkedin-md",
		font_class: "Linkedin-md",
		unicode: "ecb0",
		unicode_decimal: 60592
	},
	{
		icon_id: "45681812",
		name: "Linkedin-lg",
		font_class: "Linkedin-lg",
		unicode: "ecb1",
		unicode_decimal: 60593
	},
	{
		icon_id: "45681811",
		name: "Link2-xs",
		font_class: "Link2-xs",
		unicode: "ecb2",
		unicode_decimal: 60594
	},
	{
		icon_id: "45681810",
		name: "Link2-xl",
		font_class: "Link2-xl",
		unicode: "ecb3",
		unicode_decimal: 60595
	},
	{
		icon_id: "45681809",
		name: "Link2-sm",
		font_class: "Link2-sm",
		unicode: "ecb4",
		unicode_decimal: 60596
	},
	{
		icon_id: "45681804",
		name: "Link2-md",
		font_class: "Link2-md",
		unicode: "ecb5",
		unicode_decimal: 60597
	},
	{
		icon_id: "45681803",
		name: "Link2-lg",
		font_class: "Link2-lg",
		unicode: "ecb6",
		unicode_decimal: 60598
	},
	{
		icon_id: "45681802",
		name: "Link-xs",
		font_class: "Link-xs",
		unicode: "ecb7",
		unicode_decimal: 60599
	},
	{
		icon_id: "45681801",
		name: "Link-xl",
		font_class: "Link-xl",
		unicode: "ecb8",
		unicode_decimal: 60600
	},
	{
		icon_id: "45681815",
		name: "Linkedin-xl",
		font_class: "Linkedin-xl",
		unicode: "ecae",
		unicode_decimal: 60590
	},
	{
		icon_id: "45681814",
		name: "Linkedin-sm",
		font_class: "Linkedin-sm",
		unicode: "ecaf",
		unicode_decimal: 60591
	},
	{
		icon_id: "45681798",
		name: "Link-lg",
		font_class: "Link-lg",
		unicode: "eca4",
		unicode_decimal: 60580
	},
	{
		icon_id: "45681797",
		name: "Life buoy-xs",
		font_class: "a-Lifebuoy-xs",
		unicode: "eca5",
		unicode_decimal: 60581
	},
	{
		icon_id: "45681796",
		name: "Life buoy-xl",
		font_class: "a-Lifebuoy-xl",
		unicode: "eca6",
		unicode_decimal: 60582
	},
	{
		icon_id: "45681795",
		name: "Life buoy-sm",
		font_class: "a-Lifebuoy-sm",
		unicode: "eca7",
		unicode_decimal: 60583
	},
	{
		icon_id: "45681794",
		name: "Life buoy-md",
		font_class: "a-Lifebuoy-md",
		unicode: "eca8",
		unicode_decimal: 60584
	},
	{
		icon_id: "45681793",
		name: "Life buoy-lg",
		font_class: "a-Lifebuoy-lg",
		unicode: "eca9",
		unicode_decimal: 60585
	},
	{
		icon_id: "45681792",
		name: "Layout-xs",
		font_class: "Layout-xs",
		unicode: "ecaa",
		unicode_decimal: 60586
	},
	{
		icon_id: "45681791",
		name: "Layout-xl",
		font_class: "Layout-xl",
		unicode: "ecab",
		unicode_decimal: 60587
	},
	{
		icon_id: "45681790",
		name: "Layout-sm",
		font_class: "Layout-sm",
		unicode: "ecac",
		unicode_decimal: 60588
	},
	{
		icon_id: "45681789",
		name: "Layout-md",
		font_class: "Layout-md",
		unicode: "ecad",
		unicode_decimal: 60589
	},
	{
		icon_id: "45681800",
		name: "Link-sm",
		font_class: "Link-sm",
		unicode: "eca2",
		unicode_decimal: 60578
	},
	{
		icon_id: "45681799",
		name: "Link-md",
		font_class: "Link-md",
		unicode: "eca3",
		unicode_decimal: 60579
	},
	{
		icon_id: "45681784",
		name: "Layers-md",
		font_class: "Layers-md",
		unicode: "ec9b",
		unicode_decimal: 60571
	},
	{
		icon_id: "45681783",
		name: "Layers-lg",
		font_class: "Layers-lg",
		unicode: "ec9c",
		unicode_decimal: 60572
	},
	{
		icon_id: "45681782",
		name: "L-Sidebar-xs",
		font_class: "L-Sidebar-xs",
		unicode: "ec9d",
		unicode_decimal: 60573
	},
	{
		icon_id: "45681781",
		name: "L-Sidebar-xl",
		font_class: "L-Sidebar-xl",
		unicode: "ec9e",
		unicode_decimal: 60574
	},
	{
		icon_id: "45681780",
		name: "L-Sidebar-sm",
		font_class: "L-Sidebar-sm",
		unicode: "ec9f",
		unicode_decimal: 60575
	},
	{
		icon_id: "45681779",
		name: "L-Sidebar-md",
		font_class: "L-Sidebar-md",
		unicode: "eca0",
		unicode_decimal: 60576
	},
	{
		icon_id: "45681778",
		name: "L-Sidebar-lg",
		font_class: "L-Sidebar-lg",
		unicode: "eca1",
		unicode_decimal: 60577
	},
	{
		icon_id: "45681788",
		name: "Layout-lg",
		font_class: "Layout-lg",
		unicode: "ec97",
		unicode_decimal: 60567
	},
	{
		icon_id: "45681787",
		name: "Layers-xs",
		font_class: "Layers-xs",
		unicode: "ec98",
		unicode_decimal: 60568
	},
	{
		icon_id: "45681786",
		name: "Layers-xl",
		font_class: "Layers-xl",
		unicode: "ec99",
		unicode_decimal: 60569
	},
	{
		icon_id: "45681785",
		name: "Layers-sm",
		font_class: "Layers-sm",
		unicode: "ec9a",
		unicode_decimal: 60570
	},
	{
		icon_id: "45681773",
		name: "Keyboard-lg",
		font_class: "Keyboard-lg",
		unicode: "ec91",
		unicode_decimal: 60561
	},
	{
		icon_id: "45681772",
		name: "Key-xs",
		font_class: "Key-xs",
		unicode: "ec92",
		unicode_decimal: 60562
	},
	{
		icon_id: "45681771",
		name: "Key-xl",
		font_class: "Key-xl",
		unicode: "ec93",
		unicode_decimal: 60563
	},
	{
		icon_id: "45681770",
		name: "Key-sm",
		font_class: "Key-sm",
		unicode: "ec94",
		unicode_decimal: 60564
	},
	{
		icon_id: "45681769",
		name: "Key-md",
		font_class: "Key-md",
		unicode: "ec95",
		unicode_decimal: 60565
	},
	{
		icon_id: "45681768",
		name: "Key-lg",
		font_class: "Key-lg",
		unicode: "ec96",
		unicode_decimal: 60566
	},
	{
		icon_id: "45681777",
		name: "Keyboard-xs",
		font_class: "Keyboard-xs",
		unicode: "ec8d",
		unicode_decimal: 60557
	},
	{
		icon_id: "45681776",
		name: "Keyboard-xl",
		font_class: "Keyboard-xl",
		unicode: "ec8e",
		unicode_decimal: 60558
	},
	{
		icon_id: "45681775",
		name: "Keyboard-sm",
		font_class: "Keyboard-sm",
		unicode: "ec8f",
		unicode_decimal: 60559
	},
	{
		icon_id: "45681774",
		name: "Keyboard-md",
		font_class: "Keyboard-md",
		unicode: "ec90",
		unicode_decimal: 60560
	},
	{
		icon_id: "45681763",
		name: "Italic-lg",
		font_class: "Italic-lg",
		unicode: "ec8c",
		unicode_decimal: 60556
	},
	{
		icon_id: "45681767",
		name: "Italic-xs",
		font_class: "Italic-xs",
		unicode: "ec88",
		unicode_decimal: 60552
	},
	{
		icon_id: "45681766",
		name: "Italic-xl",
		font_class: "Italic-xl",
		unicode: "ec89",
		unicode_decimal: 60553
	},
	{
		icon_id: "45681765",
		name: "Italic-sm",
		font_class: "Italic-sm",
		unicode: "ec8a",
		unicode_decimal: 60554
	},
	{
		icon_id: "45681764",
		name: "Italic-md",
		font_class: "Italic-md",
		unicode: "ec8b",
		unicode_decimal: 60555
	},
	{
		icon_id: "45681621",
		name: "Info-xs",
		font_class: "Info-xs",
		unicode: "ec83",
		unicode_decimal: 60547
	},
	{
		icon_id: "45681620",
		name: "Info-xl",
		font_class: "Info-xl",
		unicode: "ec84",
		unicode_decimal: 60548
	},
	{
		icon_id: "45681619",
		name: "Info-sm",
		font_class: "Info-sm",
		unicode: "ec85",
		unicode_decimal: 60549
	},
	{
		icon_id: "45681618",
		name: "Info-md",
		font_class: "Info-md",
		unicode: "ec86",
		unicode_decimal: 60550
	},
	{
		icon_id: "45681617",
		name: "Info-lg",
		font_class: "Info-lg",
		unicode: "ec87",
		unicode_decimal: 60551
	},
	{
		icon_id: "45681616",
		name: "Inbox-xs",
		font_class: "Inbox-xs",
		unicode: "ec79",
		unicode_decimal: 60537
	},
	{
		icon_id: "45681615",
		name: "Inbox-xl",
		font_class: "Inbox-xl",
		unicode: "ec7a",
		unicode_decimal: 60538
	},
	{
		icon_id: "45681614",
		name: "Inbox-sm",
		font_class: "Inbox-sm",
		unicode: "ec7b",
		unicode_decimal: 60539
	},
	{
		icon_id: "45681613",
		name: "Inbox-md",
		font_class: "Inbox-md",
		unicode: "ec7c",
		unicode_decimal: 60540
	},
	{
		icon_id: "45681612",
		name: "Inbox-lg",
		font_class: "Inbox-lg",
		unicode: "ec7d",
		unicode_decimal: 60541
	},
	{
		icon_id: "45681610",
		name: "Image-xs",
		font_class: "Image-xs",
		unicode: "ec7e",
		unicode_decimal: 60542
	},
	{
		icon_id: "45681609",
		name: "Image-xl",
		font_class: "Image-xl",
		unicode: "ec7f",
		unicode_decimal: 60543
	},
	{
		icon_id: "45681608",
		name: "Image-sm",
		font_class: "Image-sm",
		unicode: "ec80",
		unicode_decimal: 60544
	},
	{
		icon_id: "45681607",
		name: "Image-md",
		font_class: "Image-md",
		unicode: "ec81",
		unicode_decimal: 60545
	},
	{
		icon_id: "45681606",
		name: "Image-lg",
		font_class: "Image-lg",
		unicode: "ec82",
		unicode_decimal: 60546
	},
	{
		icon_id: "45681596",
		name: "Hexagon-lg",
		font_class: "Hexagon-lg",
		unicode: "ec78",
		unicode_decimal: 60536
	},
	{
		icon_id: "45681605",
		name: "Home-xs",
		font_class: "Home-xs",
		unicode: "ec6f",
		unicode_decimal: 60527
	},
	{
		icon_id: "45681604",
		name: "Home-xl",
		font_class: "Home-xl",
		unicode: "ec70",
		unicode_decimal: 60528
	},
	{
		icon_id: "45681603",
		name: "Home-sm",
		font_class: "Home-sm",
		unicode: "ec71",
		unicode_decimal: 60529
	},
	{
		icon_id: "45681602",
		name: "Home-md",
		font_class: "Home-md",
		unicode: "ec72",
		unicode_decimal: 60530
	},
	{
		icon_id: "45681601",
		name: "Home-lg",
		font_class: "Home-lg",
		unicode: "ec73",
		unicode_decimal: 60531
	},
	{
		icon_id: "45681600",
		name: "Hexagon-xs",
		font_class: "Hexagon-xs",
		unicode: "ec74",
		unicode_decimal: 60532
	},
	{
		icon_id: "45681599",
		name: "Hexagon-xl",
		font_class: "Hexagon-xl",
		unicode: "ec75",
		unicode_decimal: 60533
	},
	{
		icon_id: "45681598",
		name: "Hexagon-sm",
		font_class: "Hexagon-sm",
		unicode: "ec76",
		unicode_decimal: 60534
	},
	{
		icon_id: "45681597",
		name: "Hexagon-md",
		font_class: "Hexagon-md",
		unicode: "ec77",
		unicode_decimal: 60535
	},
	{
		icon_id: "45681589",
		name: "Heart-xl",
		font_class: "Heart-xl",
		unicode: "ec6b",
		unicode_decimal: 60523
	},
	{
		icon_id: "45681588",
		name: "Heart-sm",
		font_class: "Heart-sm",
		unicode: "ec6c",
		unicode_decimal: 60524
	},
	{
		icon_id: "45681587",
		name: "Heart-md",
		font_class: "Heart-md",
		unicode: "ec6d",
		unicode_decimal: 60525
	},
	{
		icon_id: "45681586",
		name: "Heart-lg",
		font_class: "Heart-lg",
		unicode: "ec6e",
		unicode_decimal: 60526
	},
	{
		icon_id: "45681595",
		name: "Help circle-xs",
		font_class: "a-Helpcircle-xs",
		unicode: "ec65",
		unicode_decimal: 60517
	},
	{
		icon_id: "45681594",
		name: "Help circle-xl",
		font_class: "a-Helpcircle-xl",
		unicode: "ec66",
		unicode_decimal: 60518
	},
	{
		icon_id: "45681593",
		name: "Help circle-sm",
		font_class: "a-Helpcircle-sm",
		unicode: "ec67",
		unicode_decimal: 60519
	},
	{
		icon_id: "45681592",
		name: "Help circle-md",
		font_class: "a-Helpcircle-md",
		unicode: "ec68",
		unicode_decimal: 60520
	},
	{
		icon_id: "45681591",
		name: "Help circle-lg",
		font_class: "a-Helpcircle-lg",
		unicode: "ec69",
		unicode_decimal: 60521
	},
	{
		icon_id: "45681590",
		name: "Heart-xs",
		font_class: "Heart-xs",
		unicode: "ec6a",
		unicode_decimal: 60522
	},
	{
		icon_id: "45681583",
		name: "Headphones-xs",
		font_class: "Headphones-xs",
		unicode: "ec5b",
		unicode_decimal: 60507
	},
	{
		icon_id: "45681582",
		name: "Headphones-xl",
		font_class: "Headphones-xl",
		unicode: "ec5c",
		unicode_decimal: 60508
	},
	{
		icon_id: "45681581",
		name: "Headphones-sm",
		font_class: "Headphones-sm",
		unicode: "ec5d",
		unicode_decimal: 60509
	},
	{
		icon_id: "45681580",
		name: "Headphones-md",
		font_class: "Headphones-md",
		unicode: "ec5e",
		unicode_decimal: 60510
	},
	{
		icon_id: "45681579",
		name: "Headphones-lg",
		font_class: "Headphones-lg",
		unicode: "ec5f",
		unicode_decimal: 60511
	},
	{
		icon_id: "45681578",
		name: "Hash-xs",
		font_class: "Hash-xs",
		unicode: "ec60",
		unicode_decimal: 60512
	},
	{
		icon_id: "45681577",
		name: "Hash-xl",
		font_class: "Hash-xl",
		unicode: "ec61",
		unicode_decimal: 60513
	},
	{
		icon_id: "45681576",
		name: "Hash-sm",
		font_class: "Hash-sm",
		unicode: "ec62",
		unicode_decimal: 60514
	},
	{
		icon_id: "45681575",
		name: "Hash-md",
		font_class: "Hash-md",
		unicode: "ec63",
		unicode_decimal: 60515
	},
	{
		icon_id: "45681574",
		name: "Hash-lg",
		font_class: "Hash-lg",
		unicode: "ec64",
		unicode_decimal: 60516
	},
	{
		icon_id: "45681572",
		name: "Hard drive-xs",
		font_class: "a-Harddrive-xs",
		unicode: "ec50",
		unicode_decimal: 60496
	},
	{
		icon_id: "45681571",
		name: "Hard drive-xl",
		font_class: "a-Harddrive-xl",
		unicode: "ec51",
		unicode_decimal: 60497
	},
	{
		icon_id: "45681570",
		name: "Hard drive-sm",
		font_class: "a-Harddrive-sm",
		unicode: "ec52",
		unicode_decimal: 60498
	},
	{
		icon_id: "45681569",
		name: "Hard drive-md",
		font_class: "a-Harddrive-md",
		unicode: "ec53",
		unicode_decimal: 60499
	},
	{
		icon_id: "45681568",
		name: "Hard drive-lg",
		font_class: "a-Harddrive-lg",
		unicode: "ec54",
		unicode_decimal: 60500
	},
	{
		icon_id: "45681567",
		name: "Grid-xs",
		font_class: "Grid-xs",
		unicode: "ec55",
		unicode_decimal: 60501
	},
	{
		icon_id: "45681566",
		name: "Grid-xl",
		font_class: "Grid-xl",
		unicode: "ec56",
		unicode_decimal: 60502
	},
	{
		icon_id: "45681565",
		name: "Grid-sm",
		font_class: "Grid-sm",
		unicode: "ec57",
		unicode_decimal: 60503
	},
	{
		icon_id: "45681564",
		name: "Grid-md",
		font_class: "Grid-md",
		unicode: "ec58",
		unicode_decimal: 60504
	},
	{
		icon_id: "45681563",
		name: "Grid-lg",
		font_class: "Grid-lg",
		unicode: "ec59",
		unicode_decimal: 60505
	},
	{
		icon_id: "45681562",
		name: "Globe-xs",
		font_class: "Globe-xs",
		unicode: "ec5a",
		unicode_decimal: 60506
	},
	{
		icon_id: "45681560",
		name: "Globe-sm",
		font_class: "Globe-sm",
		unicode: "ec46",
		unicode_decimal: 60486
	},
	{
		icon_id: "45681559",
		name: "Globe-md",
		font_class: "Globe-md",
		unicode: "ec47",
		unicode_decimal: 60487
	},
	{
		icon_id: "45681558",
		name: "Globe-lg",
		font_class: "Globe-lg",
		unicode: "ec48",
		unicode_decimal: 60488
	},
	{
		icon_id: "45681557",
		name: "Gitlab-xs",
		font_class: "Gitlab-xs",
		unicode: "ec49",
		unicode_decimal: 60489
	},
	{
		icon_id: "45681556",
		name: "Gitlab-xl",
		font_class: "Gitlab-xl",
		unicode: "ec4a",
		unicode_decimal: 60490
	},
	{
		icon_id: "45681555",
		name: "Gitlab-sm",
		font_class: "Gitlab-sm",
		unicode: "ec4b",
		unicode_decimal: 60491
	},
	{
		icon_id: "45681521",
		name: "Gitlab-md",
		font_class: "Gitlab-md",
		unicode: "ec4c",
		unicode_decimal: 60492
	},
	{
		icon_id: "45681520",
		name: "Gitlab-lg",
		font_class: "Gitlab-lg",
		unicode: "ec4d",
		unicode_decimal: 60493
	},
	{
		icon_id: "45681519",
		name: "Github-xs",
		font_class: "Github-xs",
		unicode: "ec4e",
		unicode_decimal: 60494
	},
	{
		icon_id: "45681518",
		name: "Github-xl",
		font_class: "Github-xl",
		unicode: "ec4f",
		unicode_decimal: 60495
	},
	{
		icon_id: "45681561",
		name: "Globe-xl",
		font_class: "Globe-xl",
		unicode: "ec45",
		unicode_decimal: 60485
	},
	{
		icon_id: "45681516",
		name: "Github-md",
		font_class: "Github-md",
		unicode: "ec3b",
		unicode_decimal: 60475
	},
	{
		icon_id: "45681515",
		name: "Github-lg",
		font_class: "Github-lg",
		unicode: "ec3c",
		unicode_decimal: 60476
	},
	{
		icon_id: "45681514",
		name: "Git pull-request-xs",
		font_class: "a-Gitpull-request-xs",
		unicode: "ec3d",
		unicode_decimal: 60477
	},
	{
		icon_id: "45681513",
		name: "Git pull-request-xl",
		font_class: "a-Gitpull-request-xl",
		unicode: "ec3e",
		unicode_decimal: 60478
	},
	{
		icon_id: "45681512",
		name: "Git pull-request-sm",
		font_class: "a-Gitpull-request-sm",
		unicode: "ec3f",
		unicode_decimal: 60479
	},
	{
		icon_id: "45681511",
		name: "Git pull-request-md",
		font_class: "a-Gitpull-request-md",
		unicode: "ec40",
		unicode_decimal: 60480
	},
	{
		icon_id: "45681510",
		name: "Git pull-request-lg",
		font_class: "a-Gitpull-request-lg",
		unicode: "ec41",
		unicode_decimal: 60481
	},
	{
		icon_id: "45681509",
		name: "Git merge-xs",
		font_class: "a-Gitmerge-xs",
		unicode: "ec42",
		unicode_decimal: 60482
	},
	{
		icon_id: "45681507",
		name: "Git merge-xl",
		font_class: "a-Gitmerge-xl",
		unicode: "ec43",
		unicode_decimal: 60483
	},
	{
		icon_id: "45681506",
		name: "Git merge-sm",
		font_class: "a-Gitmerge-sm",
		unicode: "ec44",
		unicode_decimal: 60484
	},
	{
		icon_id: "45681517",
		name: "Github-sm",
		font_class: "Github-sm",
		unicode: "ec3a",
		unicode_decimal: 60474
	},
	{
		icon_id: "45681504",
		name: "Git merge-lg",
		font_class: "a-Gitmerge-lg",
		unicode: "ec31",
		unicode_decimal: 60465
	},
	{
		icon_id: "45681502",
		name: "Git commit-xs",
		font_class: "a-Gitcommit-xs",
		unicode: "ec32",
		unicode_decimal: 60466
	},
	{
		icon_id: "45681501",
		name: "Git commit-xl",
		font_class: "a-Gitcommit-xl",
		unicode: "ec33",
		unicode_decimal: 60467
	},
	{
		icon_id: "45681500",
		name: "Git commit-sm",
		font_class: "a-Gitcommit-sm",
		unicode: "ec34",
		unicode_decimal: 60468
	},
	{
		icon_id: "45681499",
		name: "Git commit-md",
		font_class: "a-Gitcommit-md",
		unicode: "ec35",
		unicode_decimal: 60469
	},
	{
		icon_id: "45681498",
		name: "Git commit-lg",
		font_class: "a-Gitcommit-lg",
		unicode: "ec36",
		unicode_decimal: 60470
	},
	{
		icon_id: "45681496",
		name: "Git branch-xs",
		font_class: "a-Gitbranch-xs",
		unicode: "ec37",
		unicode_decimal: 60471
	},
	{
		icon_id: "45681495",
		name: "Git branch-xl",
		font_class: "a-Gitbranch-xl",
		unicode: "ec38",
		unicode_decimal: 60472
	},
	{
		icon_id: "45681494",
		name: "Git branch-sm",
		font_class: "a-Gitbranch-sm",
		unicode: "ec39",
		unicode_decimal: 60473
	},
	{
		icon_id: "45681505",
		name: "Git merge-md",
		font_class: "a-Gitmerge-md",
		unicode: "ec30",
		unicode_decimal: 60464
	},
	{
		icon_id: "45681492",
		name: "Git branch-lg",
		font_class: "a-Gitbranch-lg",
		unicode: "ec26",
		unicode_decimal: 60454
	},
	{
		icon_id: "45681491",
		name: "Gift-xs",
		font_class: "Gift-xs",
		unicode: "ec27",
		unicode_decimal: 60455
	},
	{
		icon_id: "45681490",
		name: "Gift-xl",
		font_class: "Gift-xl",
		unicode: "ec28",
		unicode_decimal: 60456
	},
	{
		icon_id: "45681489",
		name: "Gift-sm",
		font_class: "Gift-sm",
		unicode: "ec29",
		unicode_decimal: 60457
	},
	{
		icon_id: "45681474",
		name: "Gift-md",
		font_class: "Gift-md",
		unicode: "ec2a",
		unicode_decimal: 60458
	},
	{
		icon_id: "45681462",
		name: "Gift-lg",
		font_class: "Gift-lg",
		unicode: "ec2b",
		unicode_decimal: 60459
	},
	{
		icon_id: "45681443",
		name: "Frown-xs",
		font_class: "Frown-xs",
		unicode: "ec2c",
		unicode_decimal: 60460
	},
	{
		icon_id: "45681442",
		name: "Frown-xl",
		font_class: "Frown-xl",
		unicode: "ec2d",
		unicode_decimal: 60461
	},
	{
		icon_id: "45681441",
		name: "Frown-sm",
		font_class: "Frown-sm",
		unicode: "ec2e",
		unicode_decimal: 60462
	},
	{
		icon_id: "45681440",
		name: "Frown-md",
		font_class: "Frown-md",
		unicode: "ec2f",
		unicode_decimal: 60463
	},
	{
		icon_id: "45681493",
		name: "Git branch-md",
		font_class: "a-Gitbranch-md",
		unicode: "ec25",
		unicode_decimal: 60453
	},
	{
		icon_id: "45681395",
		name: "Folder minus-xs",
		font_class: "a-Folderminus-xs",
		unicode: "ec21",
		unicode_decimal: 60449
	},
	{
		icon_id: "45681394",
		name: "Folder minus-xl",
		font_class: "a-Folderminus-xl",
		unicode: "ec22",
		unicode_decimal: 60450
	},
	{
		icon_id: "45681393",
		name: "Folder minus-sm",
		font_class: "a-Folderminus-sm",
		unicode: "ec23",
		unicode_decimal: 60451
	},
	{
		icon_id: "45681392",
		name: "Folder minus-md",
		font_class: "a-Folderminus-md",
		unicode: "ec24",
		unicode_decimal: 60452
	},
	{
		icon_id: "45681405",
		name: "Folder plus-xs",
		font_class: "a-Folderplus-xs",
		unicode: "ec1c",
		unicode_decimal: 60444
	},
	{
		icon_id: "45681404",
		name: "Folder plus-xl",
		font_class: "a-Folderplus-xl",
		unicode: "ec1d",
		unicode_decimal: 60445
	},
	{
		icon_id: "45681398",
		name: "Folder plus-sm",
		font_class: "a-Folderplus-sm",
		unicode: "ec1e",
		unicode_decimal: 60446
	},
	{
		icon_id: "45681397",
		name: "Folder plus-md",
		font_class: "a-Folderplus-md",
		unicode: "ec1f",
		unicode_decimal: 60447
	},
	{
		icon_id: "45681396",
		name: "Folder plus-lg",
		font_class: "a-Folderplus-lg",
		unicode: "ec20",
		unicode_decimal: 60448
	},
	{
		icon_id: "45681439",
		name: "Frown-lg",
		font_class: "Frown-lg",
		unicode: "ec1b",
		unicode_decimal: 60443
	},
	{
		icon_id: "45681356",
		name: "Folder-xl",
		font_class: "Folder-xl",
		unicode: "ec12",
		unicode_decimal: 60434
	},
	{
		icon_id: "45681355",
		name: "Folder-sm",
		font_class: "Folder-sm",
		unicode: "ec13",
		unicode_decimal: 60435
	},
	{
		icon_id: "45681354",
		name: "Folder-md",
		font_class: "Folder-md",
		unicode: "ec14",
		unicode_decimal: 60436
	},
	{
		icon_id: "45681353",
		name: "Folder-lg",
		font_class: "Folder-lg",
		unicode: "ec15",
		unicode_decimal: 60437
	},
	{
		icon_id: "45681352",
		name: "Fold instruction-xs",
		font_class: "a-Foldinstruction-xs",
		unicode: "ec16",
		unicode_decimal: 60438
	},
	{
		icon_id: "45681351",
		name: "Fold instruction-xl",
		font_class: "a-Foldinstruction-xl",
		unicode: "ec17",
		unicode_decimal: 60439
	},
	{
		icon_id: "45681350",
		name: "Fold instruction-sm",
		font_class: "a-Foldinstruction-sm",
		unicode: "ec18",
		unicode_decimal: 60440
	},
	{
		icon_id: "45681349",
		name: "Fold instruction-md",
		font_class: "a-Foldinstruction-md",
		unicode: "ec19",
		unicode_decimal: 60441
	},
	{
		icon_id: "45681348",
		name: "Fold instruction-lg",
		font_class: "a-Foldinstruction-lg",
		unicode: "ec1a",
		unicode_decimal: 60442
	},
	{
		icon_id: "45681391",
		name: "Folder minus-lg",
		font_class: "a-Folderminus-lg",
		unicode: "ec10",
		unicode_decimal: 60432
	},
	{
		icon_id: "45681357",
		name: "Folder-xs",
		font_class: "Folder-xs",
		unicode: "ec11",
		unicode_decimal: 60433
	},
	{
		icon_id: "45681345",
		name: "Flag-sm",
		font_class: "Flag-sm",
		unicode: "ec08",
		unicode_decimal: 60424
	},
	{
		icon_id: "45681344",
		name: "Flag-md",
		font_class: "Flag-md",
		unicode: "ec09",
		unicode_decimal: 60425
	},
	{
		icon_id: "45681343",
		name: "Flag-lg",
		font_class: "Flag-lg",
		unicode: "ec0a",
		unicode_decimal: 60426
	},
	{
		icon_id: "45681342",
		name: "Filter-xs",
		font_class: "Filter-xs",
		unicode: "ec0b",
		unicode_decimal: 60427
	},
	{
		icon_id: "45681341",
		name: "Filter-xl",
		font_class: "Filter-xl",
		unicode: "ec0c",
		unicode_decimal: 60428
	},
	{
		icon_id: "45681340",
		name: "Filter-sm",
		font_class: "Filter-sm",
		unicode: "ec0d",
		unicode_decimal: 60429
	},
	{
		icon_id: "45681339",
		name: "Filter-md",
		font_class: "Filter-md",
		unicode: "ec0e",
		unicode_decimal: 60430
	},
	{
		icon_id: "45681338",
		name: "Filter-lg",
		font_class: "Filter-lg",
		unicode: "ec0f",
		unicode_decimal: 60431
	},
	{
		icon_id: "45681347",
		name: "Flag-xs",
		font_class: "Flag-xs",
		unicode: "ec06",
		unicode_decimal: 60422
	},
	{
		icon_id: "45681346",
		name: "Flag-xl",
		font_class: "Flag-xl",
		unicode: "ec07",
		unicode_decimal: 60423
	},
	{
		icon_id: "45681329",
		name: "Film-xs",
		font_class: "Film-xs",
		unicode: "ebfc",
		unicode_decimal: 60412
	},
	{
		icon_id: "45681328",
		name: "Film-xl",
		font_class: "Film-xl",
		unicode: "ebfd",
		unicode_decimal: 60413
	},
	{
		icon_id: "45681327",
		name: "Film-sm",
		font_class: "Film-sm",
		unicode: "ebfe",
		unicode_decimal: 60414
	},
	{
		icon_id: "45681326",
		name: "Film-md",
		font_class: "Film-md",
		unicode: "ebff",
		unicode_decimal: 60415
	},
	{
		icon_id: "45681325",
		name: "Film-lg",
		font_class: "Film-lg",
		unicode: "ec00",
		unicode_decimal: 60416
	},
	{
		icon_id: "45681324",
		name: "File text-xs",
		font_class: "a-Filetext-xs",
		unicode: "ec01",
		unicode_decimal: 60417
	},
	{
		icon_id: "45681323",
		name: "File text-xl",
		font_class: "a-Filetext-xl",
		unicode: "ec02",
		unicode_decimal: 60418
	},
	{
		icon_id: "45681322",
		name: "File text-sm",
		font_class: "a-Filetext-sm",
		unicode: "ec03",
		unicode_decimal: 60419
	},
	{
		icon_id: "45681321",
		name: "File text-md",
		font_class: "a-Filetext-md",
		unicode: "ec04",
		unicode_decimal: 60420
	},
	{
		icon_id: "45681320",
		name: "File text-lg",
		font_class: "a-Filetext-lg",
		unicode: "ec05",
		unicode_decimal: 60421
	},
	{
		icon_id: "45681265",
		name: "File minus-xs",
		font_class: "a-Fileminus-xs",
		unicode: "ebf7",
		unicode_decimal: 60407
	},
	{
		icon_id: "45681264",
		name: "File minus-xl",
		font_class: "a-Fileminus-xl",
		unicode: "ebf8",
		unicode_decimal: 60408
	},
	{
		icon_id: "45681263",
		name: "File minus-sm",
		font_class: "a-Fileminus-sm",
		unicode: "ebf9",
		unicode_decimal: 60409
	},
	{
		icon_id: "45681260",
		name: "File minus-md",
		font_class: "a-Fileminus-md",
		unicode: "ebfa",
		unicode_decimal: 60410
	},
	{
		icon_id: "45681259",
		name: "File minus-lg",
		font_class: "a-Fileminus-lg",
		unicode: "ebfb",
		unicode_decimal: 60411
	},
	{
		icon_id: "45681267",
		name: "File plus-md",
		font_class: "a-Fileplus-md",
		unicode: "ebf5",
		unicode_decimal: 60405
	},
	{
		icon_id: "45681266",
		name: "File plus-lg",
		font_class: "a-Fileplus-lg",
		unicode: "ebf6",
		unicode_decimal: 60406
	},
	{
		icon_id: "45681270",
		name: "File plus-xs",
		font_class: "a-Fileplus-xs",
		unicode: "ebf2",
		unicode_decimal: 60402
	},
	{
		icon_id: "45681269",
		name: "File plus-xl",
		font_class: "a-Fileplus-xl",
		unicode: "ebf3",
		unicode_decimal: 60403
	},
	{
		icon_id: "45681268",
		name: "File plus-sm",
		font_class: "a-Fileplus-sm",
		unicode: "ebf4",
		unicode_decimal: 60404
	},
	{
		icon_id: "45681253",
		name: "Feather-xs",
		font_class: "Feather-xs",
		unicode: "ebed",
		unicode_decimal: 60397
	},
	{
		icon_id: "45681252",
		name: "Feather-xl",
		font_class: "Feather-xl",
		unicode: "ebee",
		unicode_decimal: 60398
	},
	{
		icon_id: "45681251",
		name: "Feather-sm",
		font_class: "Feather-sm",
		unicode: "ebef",
		unicode_decimal: 60399
	},
	{
		icon_id: "45681250",
		name: "Feather-md",
		font_class: "Feather-md",
		unicode: "ebf0",
		unicode_decimal: 60400
	},
	{
		icon_id: "45681249",
		name: "Feather-lg",
		font_class: "Feather-lg",
		unicode: "ebf1",
		unicode_decimal: 60401
	},
	{
		icon_id: "45681258",
		name: "File-xs",
		font_class: "File-xs",
		unicode: "ebe8",
		unicode_decimal: 60392
	},
	{
		icon_id: "45681257",
		name: "File-xl",
		font_class: "File-xl",
		unicode: "ebe9",
		unicode_decimal: 60393
	},
	{
		icon_id: "45681256",
		name: "File-sm",
		font_class: "File-sm",
		unicode: "ebea",
		unicode_decimal: 60394
	},
	{
		icon_id: "45681255",
		name: "File-md",
		font_class: "File-md",
		unicode: "ebeb",
		unicode_decimal: 60395
	},
	{
		icon_id: "45681254",
		name: "File-lg",
		font_class: "File-lg",
		unicode: "ebec",
		unicode_decimal: 60396
	},
	{
		icon_id: "45681212",
		name: "Facebook-xs",
		font_class: "Facebook-xs",
		unicode: "ebe2",
		unicode_decimal: 60386
	},
	{
		icon_id: "45681211",
		name: "Facebook-xl",
		font_class: "Facebook-xl",
		unicode: "ebe3",
		unicode_decimal: 60387
	},
	{
		icon_id: "45681210",
		name: "Facebook-sm",
		font_class: "Facebook-sm",
		unicode: "ebe4",
		unicode_decimal: 60388
	},
	{
		icon_id: "45681209",
		name: "Facebook-md",
		font_class: "Facebook-md",
		unicode: "ebe5",
		unicode_decimal: 60389
	},
	{
		icon_id: "45681208",
		name: "Facebook-lg",
		font_class: "Facebook-lg",
		unicode: "ebe6",
		unicode_decimal: 60390
	},
	{
		icon_id: "45681207",
		name: "Eye off-xs",
		font_class: "a-Eyeoff-xs",
		unicode: "ebe7",
		unicode_decimal: 60391
	},
	{
		icon_id: "45681248",
		name: "Fast forward-xs",
		font_class: "a-Fastforward-xs",
		unicode: "ebdd",
		unicode_decimal: 60381
	},
	{
		icon_id: "45681247",
		name: "Fast forward-xl",
		font_class: "a-Fastforward-xl",
		unicode: "ebde",
		unicode_decimal: 60382
	},
	{
		icon_id: "45681246",
		name: "Fast forward-sm",
		font_class: "a-Fastforward-sm",
		unicode: "ebdf",
		unicode_decimal: 60383
	},
	{
		icon_id: "45681245",
		name: "Fast forward-md",
		font_class: "a-Fastforward-md",
		unicode: "ebe0",
		unicode_decimal: 60384
	},
	{
		icon_id: "45681244",
		name: "Fast forward-lg",
		font_class: "a-Fastforward-lg",
		unicode: "ebe1",
		unicode_decimal: 60385
	},
	{
		icon_id: "45681199",
		name: "Eye-sm",
		font_class: "Eye-sm",
		unicode: "ebd9",
		unicode_decimal: 60377
	},
	{
		icon_id: "45681197",
		name: "Eye-md",
		font_class: "Eye-md",
		unicode: "ebda",
		unicode_decimal: 60378
	},
	{
		icon_id: "45681196",
		name: "Eye-lg",
		font_class: "Eye-lg",
		unicode: "ebdb",
		unicode_decimal: 60379
	},
	{
		icon_id: "45681195",
		name: "External link-xs",
		font_class: "a-Externallink-xs",
		unicode: "ebdc",
		unicode_decimal: 60380
	},
	{
		icon_id: "45681205",
		name: "Eye off-xl",
		font_class: "a-Eyeoff-xl",
		unicode: "ebd3",
		unicode_decimal: 60371
	},
	{
		icon_id: "45681204",
		name: "Eye off-sm",
		font_class: "a-Eyeoff-sm",
		unicode: "ebd4",
		unicode_decimal: 60372
	},
	{
		icon_id: "45681203",
		name: "Eye off-md",
		font_class: "a-Eyeoff-md",
		unicode: "ebd5",
		unicode_decimal: 60373
	},
	{
		icon_id: "45681202",
		name: "Eye off-lg",
		font_class: "a-Eyeoff-lg",
		unicode: "ebd6",
		unicode_decimal: 60374
	},
	{
		icon_id: "45681201",
		name: "Eye-xs",
		font_class: "Eye-xs",
		unicode: "ebd7",
		unicode_decimal: 60375
	},
	{
		icon_id: "45681200",
		name: "Eye-xl",
		font_class: "Eye-xl",
		unicode: "ebd8",
		unicode_decimal: 60376
	},
	{
		icon_id: "45681188",
		name: "Expand all-sm",
		font_class: "a-Expandall-sm",
		unicode: "ebce",
		unicode_decimal: 60366
	},
	{
		icon_id: "45681187",
		name: "Expand all-md",
		font_class: "a-Expandall-md",
		unicode: "ebcf",
		unicode_decimal: 60367
	},
	{
		icon_id: "45681186",
		name: "Expand all-lg",
		font_class: "a-Expandall-lg",
		unicode: "ebd0",
		unicode_decimal: 60368
	},
	{
		icon_id: "45681185",
		name: "Edit3-xs",
		font_class: "Edit3-xs",
		unicode: "ebd1",
		unicode_decimal: 60369
	},
	{
		icon_id: "45681184",
		name: "Edit3-xl",
		font_class: "Edit3-xl",
		unicode: "ebd2",
		unicode_decimal: 60370
	},
	{
		icon_id: "45681194",
		name: "External link-xl",
		font_class: "a-Externallink-xl",
		unicode: "ebc8",
		unicode_decimal: 60360
	},
	{
		icon_id: "45681193",
		name: "External link-sm",
		font_class: "a-Externallink-sm",
		unicode: "ebc9",
		unicode_decimal: 60361
	},
	{
		icon_id: "45681192",
		name: "External link-md",
		font_class: "a-Externallink-md",
		unicode: "ebca",
		unicode_decimal: 60362
	},
	{
		icon_id: "45681191",
		name: "External link-lg",
		font_class: "a-Externallink-lg",
		unicode: "ebcb",
		unicode_decimal: 60363
	},
	{
		icon_id: "45681190",
		name: "Expand all-xs",
		font_class: "a-Expandall-xs",
		unicode: "ebcc",
		unicode_decimal: 60364
	},
	{
		icon_id: "45681189",
		name: "Expand all-xl",
		font_class: "a-Expandall-xl",
		unicode: "ebcd",
		unicode_decimal: 60365
	},
	{
		icon_id: "45681176",
		name: "Edit2-lg",
		font_class: "Edit2-lg",
		unicode: "ebc4",
		unicode_decimal: 60356
	},
	{
		icon_id: "45681174",
		name: "Edit-xs",
		font_class: "Edit-xs",
		unicode: "ebc5",
		unicode_decimal: 60357
	},
	{
		icon_id: "45681173",
		name: "Edit-xl",
		font_class: "Edit-xl",
		unicode: "ebc6",
		unicode_decimal: 60358
	},
	{
		icon_id: "45681172",
		name: "Edit-sm",
		font_class: "Edit-sm",
		unicode: "ebc7",
		unicode_decimal: 60359
	},
	{
		icon_id: "45681183",
		name: "Edit3-sm",
		font_class: "Edit3-sm",
		unicode: "ebbd",
		unicode_decimal: 60349
	},
	{
		icon_id: "45681182",
		name: "Edit3-md",
		font_class: "Edit3-md",
		unicode: "ebbe",
		unicode_decimal: 60350
	},
	{
		icon_id: "45681181",
		name: "Edit3-lg",
		font_class: "Edit3-lg",
		unicode: "ebbf",
		unicode_decimal: 60351
	},
	{
		icon_id: "45681180",
		name: "Edit2-xs",
		font_class: "Edit2-xs",
		unicode: "ebc0",
		unicode_decimal: 60352
	},
	{
		icon_id: "45681179",
		name: "Edit2-xl",
		font_class: "Edit2-xl",
		unicode: "ebc1",
		unicode_decimal: 60353
	},
	{
		icon_id: "45681178",
		name: "Edit2-sm",
		font_class: "Edit2-sm",
		unicode: "ebc2",
		unicode_decimal: 60354
	},
	{
		icon_id: "45681177",
		name: "Edit2-md",
		font_class: "Edit2-md",
		unicode: "ebc3",
		unicode_decimal: 60355
	},
	{
		icon_id: "45681163",
		name: "Dribbble-xs",
		font_class: "Dribbble-xs",
		unicode: "ebba",
		unicode_decimal: 60346
	},
	{
		icon_id: "45681162",
		name: "Dribbble-xl",
		font_class: "Dribbble-xl",
		unicode: "ebbb",
		unicode_decimal: 60347
	},
	{
		icon_id: "45681161",
		name: "Dribbble-sm",
		font_class: "Dribbble-sm",
		unicode: "ebbc",
		unicode_decimal: 60348
	},
	{
		icon_id: "45681171",
		name: "Edit-md",
		font_class: "Edit-md",
		unicode: "ebb3",
		unicode_decimal: 60339
	},
	{
		icon_id: "45681170",
		name: "Edit-lg",
		font_class: "Edit-lg",
		unicode: "ebb4",
		unicode_decimal: 60340
	},
	{
		icon_id: "45681169",
		name: "Droplet-xs",
		font_class: "Droplet-xs",
		unicode: "ebb5",
		unicode_decimal: 60341
	},
	{
		icon_id: "45681168",
		name: "Droplet-xl",
		font_class: "Droplet-xl",
		unicode: "ebb6",
		unicode_decimal: 60342
	},
	{
		icon_id: "45681167",
		name: "Droplet-sm",
		font_class: "Droplet-sm",
		unicode: "ebb7",
		unicode_decimal: 60343
	},
	{
		icon_id: "45681166",
		name: "Droplet-md",
		font_class: "Droplet-md",
		unicode: "ebb8",
		unicode_decimal: 60344
	},
	{
		icon_id: "45681165",
		name: "Droplet-lg",
		font_class: "Droplet-lg",
		unicode: "ebb9",
		unicode_decimal: 60345
	},
	{
		icon_id: "45681152",
		name: "Download cloud-xl",
		font_class: "a-Downloadcloud-xl",
		unicode: "ebb0",
		unicode_decimal: 60336
	},
	{
		icon_id: "45681151",
		name: "Download cloud-sm",
		font_class: "a-Downloadcloud-sm",
		unicode: "ebb1",
		unicode_decimal: 60337
	},
	{
		icon_id: "45681150",
		name: "Download cloud-md",
		font_class: "a-Downloadcloud-md",
		unicode: "ebb2",
		unicode_decimal: 60338
	},
	{
		icon_id: "45681160",
		name: "Dribbble-md",
		font_class: "Dribbble-md",
		unicode: "eba8",
		unicode_decimal: 60328
	},
	{
		icon_id: "45681159",
		name: "Dribbble-lg",
		font_class: "Dribbble-lg",
		unicode: "eba9",
		unicode_decimal: 60329
	},
	{
		icon_id: "45681158",
		name: "Drag-xs",
		font_class: "Drag-xs",
		unicode: "ebaa",
		unicode_decimal: 60330
	},
	{
		icon_id: "45681157",
		name: "Drag-xl",
		font_class: "Drag-xl",
		unicode: "ebab",
		unicode_decimal: 60331
	},
	{
		icon_id: "45681156",
		name: "Drag-sm",
		font_class: "Drag-sm",
		unicode: "ebac",
		unicode_decimal: 60332
	},
	{
		icon_id: "45681155",
		name: "Drag-md",
		font_class: "Drag-md",
		unicode: "ebad",
		unicode_decimal: 60333
	},
	{
		icon_id: "45681154",
		name: "Drag-lg",
		font_class: "Drag-lg",
		unicode: "ebae",
		unicode_decimal: 60334
	},
	{
		icon_id: "45681153",
		name: "Download cloud-xs",
		font_class: "a-Downloadcloud-xs",
		unicode: "ebaf",
		unicode_decimal: 60335
	},
	{
		icon_id: "45681140",
		name: "Download-md",
		font_class: "Download-md",
		unicode: "eba2",
		unicode_decimal: 60322
	},
	{
		icon_id: "45681139",
		name: "Download-lg",
		font_class: "Download-lg",
		unicode: "eba3",
		unicode_decimal: 60323
	},
	{
		icon_id: "45681138",
		name: "Dollar sign-xs",
		font_class: "a-Dollarsign-xs",
		unicode: "eba4",
		unicode_decimal: 60324
	},
	{
		icon_id: "45681137",
		name: "Dollar sign-xl",
		font_class: "a-Dollarsign-xl",
		unicode: "eba5",
		unicode_decimal: 60325
	},
	{
		icon_id: "45681136",
		name: "Dollar sign-sm",
		font_class: "a-Dollarsign-sm",
		unicode: "eba6",
		unicode_decimal: 60326
	},
	{
		icon_id: "45681135",
		name: "Dollar sign-md",
		font_class: "a-Dollarsign-md",
		unicode: "eba7",
		unicode_decimal: 60327
	},
	{
		icon_id: "45681149",
		name: "Download cloud-lg",
		font_class: "a-Downloadcloud-lg",
		unicode: "eb9e",
		unicode_decimal: 60318
	},
	{
		icon_id: "45681143",
		name: "Download-xs",
		font_class: "Download-xs",
		unicode: "eb9f",
		unicode_decimal: 60319
	},
	{
		icon_id: "45681142",
		name: "Download-xl",
		font_class: "Download-xl",
		unicode: "eba0",
		unicode_decimal: 60320
	},
	{
		icon_id: "45681141",
		name: "Download-sm",
		font_class: "Download-sm",
		unicode: "eba1",
		unicode_decimal: 60321
	},
	{
		icon_id: "45681134",
		name: "Dollar sign-lg",
		font_class: "a-Dollarsign-lg",
		unicode: "eb9d",
		unicode_decimal: 60317
	},
	{
		icon_id: "45679519",
		name: "Collapse all-xs",
		font_class: "a-Collapseall-xs",
		unicode: "eb9b",
		unicode_decimal: 60315
	},
	{
		icon_id: "45679518",
		name: "Collapse all-xl",
		font_class: "a-Collapseall-xl",
		unicode: "eb9c",
		unicode_decimal: 60316
	},
	{
		icon_id: "45679493",
		name: "Collapse all-md",
		font_class: "a-Collapseall-md",
		unicode: "eb94",
		unicode_decimal: 60308
	},
	{
		icon_id: "45679492",
		name: "Collapse all-lg",
		font_class: "a-Collapseall-lg",
		unicode: "eb95",
		unicode_decimal: 60309
	},
	{
		icon_id: "45679488",
		name: "Bug-xs",
		font_class: "Bug-xs",
		unicode: "eb96",
		unicode_decimal: 60310
	},
	{
		icon_id: "45679486",
		name: "Bug-xl",
		font_class: "Bug-xl",
		unicode: "eb97",
		unicode_decimal: 60311
	},
	{
		icon_id: "45679484",
		name: "Bug-sm",
		font_class: "Bug-sm",
		unicode: "eb98",
		unicode_decimal: 60312
	},
	{
		icon_id: "45679483",
		name: "Bug-md",
		font_class: "Bug-md",
		unicode: "eb99",
		unicode_decimal: 60313
	},
	{
		icon_id: "45679482",
		name: "Bug-lg",
		font_class: "Bug-lg",
		unicode: "eb9a",
		unicode_decimal: 60314
	},
	{
		icon_id: "45679517",
		name: "Collapse all-sm",
		font_class: "a-Collapseall-sm",
		unicode: "eb93",
		unicode_decimal: 60307
	},
	{
		icon_id: "45679476",
		name: "Bottombar-xs",
		font_class: "Bottombar-xs",
		unicode: "eb8a",
		unicode_decimal: 60298
	},
	{
		icon_id: "45679474",
		name: "Bottombar-xl",
		font_class: "Bottombar-xl",
		unicode: "eb8b",
		unicode_decimal: 60299
	},
	{
		icon_id: "45679472",
		name: "Bottombar-sm",
		font_class: "Bottombar-sm",
		unicode: "eb8c",
		unicode_decimal: 60300
	},
	{
		icon_id: "45679471",
		name: "Bottombar-md",
		font_class: "Bottombar-md",
		unicode: "eb8d",
		unicode_decimal: 60301
	},
	{
		icon_id: "45679469",
		name: "Bottombar-lg",
		font_class: "Bottombar-lg",
		unicode: "eb8e",
		unicode_decimal: 60302
	},
	{
		icon_id: "45679467",
		name: "Backspace-xs",
		font_class: "Backspace-xs",
		unicode: "eb8f",
		unicode_decimal: 60303
	},
	{
		icon_id: "45679466",
		name: "Backspace-xl",
		font_class: "Backspace-xl",
		unicode: "eb90",
		unicode_decimal: 60304
	},
	{
		icon_id: "45679464",
		name: "Backspace-sm",
		font_class: "Backspace-sm",
		unicode: "eb91",
		unicode_decimal: 60305
	},
	{
		icon_id: "45679463",
		name: "Backspace-md",
		font_class: "Backspace-md",
		unicode: "eb92",
		unicode_decimal: 60306
	},
	{
		icon_id: "45679462",
		name: "Backspace-lg",
		font_class: "Backspace-lg",
		unicode: "eb83",
		unicode_decimal: 60291
	},
	{
		icon_id: "45679459",
		name: "App-xs",
		font_class: "App-xs",
		unicode: "eb84",
		unicode_decimal: 60292
	},
	{
		icon_id: "45679458",
		name: "App-xl",
		font_class: "App-xl",
		unicode: "eb85",
		unicode_decimal: 60293
	},
	{
		icon_id: "45679457",
		name: "App-sm",
		font_class: "App-sm",
		unicode: "eb86",
		unicode_decimal: 60294
	},
	{
		icon_id: "45679456",
		name: "App-md",
		font_class: "App-md",
		unicode: "eb87",
		unicode_decimal: 60295
	},
	{
		icon_id: "45679455",
		name: "App-lg",
		font_class: "App-lg",
		unicode: "eb88",
		unicode_decimal: 60296
	},
	{
		icon_id: "45679450",
		name: "Add variable-xs",
		font_class: "a-Addvariable-xs",
		unicode: "eb89",
		unicode_decimal: 60297
	},
	{
		icon_id: "45679448",
		name: "Add variable-xl",
		font_class: "a-Addvariable-xl",
		unicode: "eb7a",
		unicode_decimal: 60282
	},
	{
		icon_id: "45679447",
		name: "Add variable-sm",
		font_class: "a-Addvariable-sm",
		unicode: "eb7b",
		unicode_decimal: 60283
	},
	{
		icon_id: "45679444",
		name: "Add variable-md",
		font_class: "a-Addvariable-md",
		unicode: "eb7c",
		unicode_decimal: 60284
	},
	{
		icon_id: "45679442",
		name: "Add variable-lg",
		font_class: "a-Addvariable-lg",
		unicode: "eb7d",
		unicode_decimal: 60285
	},
	{
		icon_id: "45679437",
		name: "AI-xs",
		font_class: "AI-xs",
		unicode: "eb7e",
		unicode_decimal: 60286
	},
	{
		icon_id: "45679436",
		name: "AI-xl",
		font_class: "AI-xl",
		unicode: "eb7f",
		unicode_decimal: 60287
	},
	{
		icon_id: "45679432",
		name: "AI-sm",
		font_class: "AI-sm",
		unicode: "eb80",
		unicode_decimal: 60288
	},
	{
		icon_id: "45679431",
		name: "AI-md",
		font_class: "AI-md",
		unicode: "eb81",
		unicode_decimal: 60289
	},
	{
		icon_id: "45679430",
		name: "AI-lg",
		font_class: "AI-lg",
		unicode: "eb82",
		unicode_decimal: 60290
	},
	{
		icon_id: "45677116",
		name: "Credit card-sm",
		font_class: "a-Creditcard-sm",
		unicode: "eb75",
		unicode_decimal: 60277
	},
	{
		icon_id: "45677115",
		name: "Credit card-lg",
		font_class: "a-Creditcard-lg",
		unicode: "eb76",
		unicode_decimal: 60278
	},
	{
		icon_id: "45677114",
		name: "Credit card-md",
		font_class: "a-Creditcard-md",
		unicode: "eb77",
		unicode_decimal: 60279
	},
	{
		icon_id: "45677113",
		name: "Credit card-xl",
		font_class: "a-Creditcard-xl",
		unicode: "eb78",
		unicode_decimal: 60280
	},
	{
		icon_id: "45677112",
		name: "Credit card-xs",
		font_class: "a-Creditcard-xs",
		unicode: "eb79",
		unicode_decimal: 60281
	},
	{
		icon_id: "45676976",
		name: "Crop-xs",
		font_class: "Crop-xs",
		unicode: "eb70",
		unicode_decimal: 60272
	},
	{
		icon_id: "45676974",
		name: "Crop-xl",
		font_class: "Crop-xl",
		unicode: "eb71",
		unicode_decimal: 60273
	},
	{
		icon_id: "45676975",
		name: "Crop-md",
		font_class: "Crop-md",
		unicode: "eb72",
		unicode_decimal: 60274
	},
	{
		icon_id: "45676973",
		name: "Crop-sm",
		font_class: "Crop-sm",
		unicode: "eb73",
		unicode_decimal: 60275
	},
	{
		icon_id: "45676972",
		name: "Crop-lg",
		font_class: "Crop-lg",
		unicode: "eb74",
		unicode_decimal: 60276
	},
	{
		icon_id: "45676840",
		name: "Crosshair-xl",
		font_class: "Crosshair-xl",
		unicode: "eb5d",
		unicode_decimal: 60253
	},
	{
		icon_id: "45676839",
		name: "Crosshair-sm",
		font_class: "Crosshair-sm",
		unicode: "eb5e",
		unicode_decimal: 60254
	},
	{
		icon_id: "45676837",
		name: "Crosshair-md",
		font_class: "Crosshair-md",
		unicode: "eb5f",
		unicode_decimal: 60255
	},
	{
		icon_id: "45676838",
		name: "Crosshair-xs",
		font_class: "Crosshair-xs",
		unicode: "eb60",
		unicode_decimal: 60256
	},
	{
		icon_id: "45676836",
		name: "Crosshair-lg",
		font_class: "Crosshair-lg",
		unicode: "eb66",
		unicode_decimal: 60262
	},
	{
		icon_id: "45676385",
		name: "Database-xs",
		font_class: "Database-xs",
		unicode: "eb6b",
		unicode_decimal: 60267
	},
	{
		icon_id: "45676384",
		name: "Database-lg",
		font_class: "Database-lg",
		unicode: "eb6c",
		unicode_decimal: 60268
	},
	{
		icon_id: "45676383",
		name: "Database-sm",
		font_class: "Database-sm",
		unicode: "eb6d",
		unicode_decimal: 60269
	},
	{
		icon_id: "45676382",
		name: "Database-md",
		font_class: "Database-md",
		unicode: "eb6e",
		unicode_decimal: 60270
	},
	{
		icon_id: "45676381",
		name: "Database-xl",
		font_class: "Database-xl",
		unicode: "eb6f",
		unicode_decimal: 60271
	},
	{
		icon_id: "45676145",
		name: "Divide-sm",
		font_class: "Divide-sm",
		unicode: "eb5c",
		unicode_decimal: 60252
	},
	{
		icon_id: "45676061",
		name: "Divide-xs",
		font_class: "Divide-xs",
		unicode: "eb67",
		unicode_decimal: 60263
	},
	{
		icon_id: "45676062",
		name: "Divide-md",
		font_class: "Divide-md",
		unicode: "eb68",
		unicode_decimal: 60264
	},
	{
		icon_id: "45676059",
		name: "Divide-lg",
		font_class: "Divide-lg",
		unicode: "eb69",
		unicode_decimal: 60265
	},
	{
		icon_id: "45676060",
		name: "Divide-xl",
		font_class: "Divide-xl",
		unicode: "eb6a",
		unicode_decimal: 60266
	},
	{
		icon_id: "45676072",
		name: "Divide circle-lg",
		font_class: "a-Dividecircle-lg",
		unicode: "eb61",
		unicode_decimal: 60257
	},
	{
		icon_id: "45676071",
		name: "Divide circle-xl",
		font_class: "a-Dividecircle-xl",
		unicode: "eb62",
		unicode_decimal: 60258
	},
	{
		icon_id: "45676070",
		name: "Divide circle-sm",
		font_class: "a-Dividecircle-sm",
		unicode: "eb63",
		unicode_decimal: 60259
	},
	{
		icon_id: "45676069",
		name: "Divide circle-xs",
		font_class: "a-Dividecircle-xs",
		unicode: "eb64",
		unicode_decimal: 60260
	},
	{
		icon_id: "45676068",
		name: "Divide circle-md",
		font_class: "a-Dividecircle-md",
		unicode: "eb65",
		unicode_decimal: 60261
	},
	{
		icon_id: "45676084",
		name: "Delete-lg",
		font_class: "Delete-lg",
		unicode: "eb52",
		unicode_decimal: 60242
	},
	{
		icon_id: "45676085",
		name: "Delete-xs",
		font_class: "Delete-xs",
		unicode: "eb53",
		unicode_decimal: 60243
	},
	{
		icon_id: "45676083",
		name: "Delete-md",
		font_class: "Delete-md",
		unicode: "eb56",
		unicode_decimal: 60246
	},
	{
		icon_id: "45676082",
		name: "Delete-sm",
		font_class: "Delete-sm",
		unicode: "eb57",
		unicode_decimal: 60247
	},
	{
		icon_id: "45676081",
		name: "Delete-xl",
		font_class: "Delete-xl",
		unicode: "eb5a",
		unicode_decimal: 60250
	},
	{
		icon_id: "45675981",
		name: "Divide square-sm",
		font_class: "a-Dividesquare-sm",
		unicode: "eb55",
		unicode_decimal: 60245
	},
	{
		icon_id: "45675975",
		name: "Divide square-lg",
		font_class: "a-Dividesquare-lg",
		unicode: "eb58",
		unicode_decimal: 60248
	},
	{
		icon_id: "45675978",
		name: "Divide square-xl",
		font_class: "a-Dividesquare-xl",
		unicode: "eb59",
		unicode_decimal: 60249
	},
	{
		icon_id: "45675974",
		name: "Divide square-xs",
		font_class: "a-Dividesquare-xs",
		unicode: "eb5b",
		unicode_decimal: 60251
	},
	{
		icon_id: "45675979",
		name: "Divide square-md",
		font_class: "a-Dividesquare-md",
		unicode: "eb54",
		unicode_decimal: 60244
	},
	{
		icon_id: "45675958",
		name: "Cpu-xs",
		font_class: "Cpu-xs",
		unicode: "eb4d",
		unicode_decimal: 60237
	},
	{
		icon_id: "45675957",
		name: "Cpu-md",
		font_class: "Cpu-md",
		unicode: "eb4e",
		unicode_decimal: 60238
	},
	{
		icon_id: "45675956",
		name: "Cpu-lg",
		font_class: "Cpu-lg",
		unicode: "eb4f",
		unicode_decimal: 60239
	},
	{
		icon_id: "45675955",
		name: "Cpu-sm",
		font_class: "Cpu-sm",
		unicode: "eb50",
		unicode_decimal: 60240
	},
	{
		icon_id: "45675954",
		name: "Cpu-xl",
		font_class: "Cpu-xl",
		unicode: "eb51",
		unicode_decimal: 60241
	},
	{
		icon_id: "45675258",
		name: "Corner up-right-xl",
		font_class: "a-Cornerup-right-xl",
		unicode: "eb48",
		unicode_decimal: 60232
	},
	{
		icon_id: "45675260",
		name: "Corner up-right-sm",
		font_class: "a-Cornerup-right-sm",
		unicode: "eb49",
		unicode_decimal: 60233
	},
	{
		icon_id: "45675257",
		name: "Corner up-right-md",
		font_class: "a-Cornerup-right-md",
		unicode: "eb4a",
		unicode_decimal: 60234
	},
	{
		icon_id: "45675259",
		name: "Corner up-right-xs",
		font_class: "a-Cornerup-right-xs",
		unicode: "eb4b",
		unicode_decimal: 60235
	},
	{
		icon_id: "45675256",
		name: "Corner up-right-lg",
		font_class: "a-Cornerup-right-lg",
		unicode: "eb4c",
		unicode_decimal: 60236
	},
	{
		icon_id: "45672145",
		name: "Corner up-left-md",
		font_class: "a-Cornerup-left-md",
		unicode: "eb43",
		unicode_decimal: 60227
	},
	{
		icon_id: "45672144",
		name: "Corner up-left-xs",
		font_class: "a-Cornerup-left-xs",
		unicode: "eb44",
		unicode_decimal: 60228
	},
	{
		icon_id: "45672141",
		name: "Corner up-left-sm",
		font_class: "a-Cornerup-left-sm",
		unicode: "eb45",
		unicode_decimal: 60229
	},
	{
		icon_id: "45672142",
		name: "Corner up-left-lg",
		font_class: "a-Cornerup-left-lg",
		unicode: "eb46",
		unicode_decimal: 60230
	},
	{
		icon_id: "45672143",
		name: "Corner up-left-xl",
		font_class: "a-Cornerup-left-xl",
		unicode: "eb47",
		unicode_decimal: 60231
	},
	{
		icon_id: "45672037",
		name: "Corner right-up-xs",
		font_class: "a-Cornerright-up-xs",
		unicode: "eb42",
		unicode_decimal: 60226
	},
	{
		icon_id: "45672039",
		name: "Corner right-up-xl",
		font_class: "a-Cornerright-up-xl",
		unicode: "eb3e",
		unicode_decimal: 60222
	},
	{
		icon_id: "45672038",
		name: "Corner right-up-md",
		font_class: "a-Cornerright-up-md",
		unicode: "eb3f",
		unicode_decimal: 60223
	},
	{
		icon_id: "45672040",
		name: "Corner right-up-lg",
		font_class: "a-Cornerright-up-lg",
		unicode: "eb40",
		unicode_decimal: 60224
	},
	{
		icon_id: "45672036",
		name: "Corner right-up-sm",
		font_class: "a-Cornerright-up-sm",
		unicode: "eb41",
		unicode_decimal: 60225
	},
	{
		icon_id: "45671934",
		name: "Corner right-down-md",
		font_class: "a-Cornerright-down-md",
		unicode: "eb3a",
		unicode_decimal: 60218
	},
	{
		icon_id: "45671931",
		name: "Corner right-down-xs",
		font_class: "a-Cornerright-down-xs",
		unicode: "eb3b",
		unicode_decimal: 60219
	},
	{
		icon_id: "45671932",
		name: "Corner right-down-sm",
		font_class: "a-Cornerright-down-sm",
		unicode: "eb3c",
		unicode_decimal: 60220
	},
	{
		icon_id: "45671933",
		name: "Corner right-down-lg",
		font_class: "a-Cornerright-down-lg",
		unicode: "eb3d",
		unicode_decimal: 60221
	},
	{
		icon_id: "45671935",
		name: "Corner right-down-xl",
		font_class: "a-Cornerright-down-xl",
		unicode: "eb39",
		unicode_decimal: 60217
	},
	{
		icon_id: "45671864",
		name: "Corner left-up-lg",
		font_class: "a-Cornerleft-up-lg",
		unicode: "eb34",
		unicode_decimal: 60212
	},
	{
		icon_id: "45671863",
		name: "Corner left-up-md",
		font_class: "a-Cornerleft-up-md",
		unicode: "eb35",
		unicode_decimal: 60213
	},
	{
		icon_id: "45671862",
		name: "Corner left-up-xs",
		font_class: "a-Cornerleft-up-xs",
		unicode: "eb36",
		unicode_decimal: 60214
	},
	{
		icon_id: "45671861",
		name: "Corner left-up-sm",
		font_class: "a-Cornerleft-up-sm",
		unicode: "eb37",
		unicode_decimal: 60215
	},
	{
		icon_id: "45671860",
		name: "Corner left-up-xl",
		font_class: "a-Cornerleft-up-xl",
		unicode: "eb38",
		unicode_decimal: 60216
	},
	{
		icon_id: "45671808",
		name: "Corner down-right-sm",
		font_class: "a-Cornerdown-right-sm",
		unicode: "eb33",
		unicode_decimal: 60211
	},
	{
		icon_id: "45671812",
		name: "Corner down-right-md",
		font_class: "a-Cornerdown-right-md",
		unicode: "eb2f",
		unicode_decimal: 60207
	},
	{
		icon_id: "45671811",
		name: "Corner down-right-lg",
		font_class: "a-Cornerdown-right-lg",
		unicode: "eb30",
		unicode_decimal: 60208
	},
	{
		icon_id: "45671810",
		name: "Corner down-right-xs",
		font_class: "a-Cornerdown-right-xs",
		unicode: "eb31",
		unicode_decimal: 60209
	},
	{
		icon_id: "45671809",
		name: "Corner down-right-xl",
		font_class: "a-Cornerdown-right-xl",
		unicode: "eb32",
		unicode_decimal: 60210
	},
	{
		icon_id: "45671633",
		name: "Corner down-left-xs",
		font_class: "a-Cornerdown-left-xs",
		unicode: "eb2a",
		unicode_decimal: 60202
	},
	{
		icon_id: "45671634",
		name: "Corner down-left-sm",
		font_class: "a-Cornerdown-left-sm",
		unicode: "eb2b",
		unicode_decimal: 60203
	},
	{
		icon_id: "45671632",
		name: "Corner down-left-xl",
		font_class: "a-Cornerdown-left-xl",
		unicode: "eb2c",
		unicode_decimal: 60204
	},
	{
		icon_id: "45671631",
		name: "Corner down-left-md",
		font_class: "a-Cornerdown-left-md",
		unicode: "eb2d",
		unicode_decimal: 60205
	},
	{
		icon_id: "45671630",
		name: "Corner down-left-lg",
		font_class: "a-Cornerdown-left-lg",
		unicode: "eb2e",
		unicode_decimal: 60206
	},
	{
		icon_id: "45671498",
		name: "Copy-xl",
		font_class: "Copy-xl",
		unicode: "eb25",
		unicode_decimal: 60197
	},
	{
		icon_id: "45671497",
		name: "Copy-md",
		font_class: "Copy-md",
		unicode: "eb26",
		unicode_decimal: 60198
	},
	{
		icon_id: "45671496",
		name: "Copy-lg",
		font_class: "Copy-lg",
		unicode: "eb27",
		unicode_decimal: 60199
	},
	{
		icon_id: "45671495",
		name: "Copy-sm",
		font_class: "Copy-sm",
		unicode: "eb28",
		unicode_decimal: 60200
	},
	{
		icon_id: "45671494",
		name: "Copy-xs",
		font_class: "Copy-xs",
		unicode: "eb29",
		unicode_decimal: 60201
	},
	{
		icon_id: "45671352",
		name: "Compass-xl",
		font_class: "Compass-xl",
		unicode: "eb20",
		unicode_decimal: 60192
	},
	{
		icon_id: "45671351",
		name: "Compass-lg",
		font_class: "Compass-lg",
		unicode: "eb21",
		unicode_decimal: 60193
	},
	{
		icon_id: "45671350",
		name: "Compass-md",
		font_class: "Compass-md",
		unicode: "eb22",
		unicode_decimal: 60194
	},
	{
		icon_id: "45671349",
		name: "Compass-xs",
		font_class: "Compass-xs",
		unicode: "eb23",
		unicode_decimal: 60195
	},
	{
		icon_id: "45671348",
		name: "Compass-sm",
		font_class: "Compass-sm",
		unicode: "eb24",
		unicode_decimal: 60196
	},
	{
		icon_id: "45671284",
		name: "Command-xs",
		font_class: "Command-xs",
		unicode: "eb1c",
		unicode_decimal: 60188
	},
	{
		icon_id: "45671283",
		name: "Command-md",
		font_class: "Command-md",
		unicode: "eb1d",
		unicode_decimal: 60189
	},
	{
		icon_id: "45671281",
		name: "Command-lg",
		font_class: "Command-lg",
		unicode: "eb1e",
		unicode_decimal: 60190
	},
	{
		icon_id: "45671280",
		name: "Command-xl",
		font_class: "Command-xl",
		unicode: "eb1f",
		unicode_decimal: 60191
	},
	{
		icon_id: "45671282",
		name: "Command-sm",
		font_class: "Command-sm",
		unicode: "eb1b",
		unicode_decimal: 60187
	},
	{
		icon_id: "45671216",
		name: "Columns-lg",
		font_class: "Columns-lg",
		unicode: "eb16",
		unicode_decimal: 60182
	},
	{
		icon_id: "45671215",
		name: "Columns-md",
		font_class: "Columns-md",
		unicode: "eb17",
		unicode_decimal: 60183
	},
	{
		icon_id: "45671213",
		name: "Columns-xs",
		font_class: "Columns-xs",
		unicode: "eb18",
		unicode_decimal: 60184
	},
	{
		icon_id: "45671214",
		name: "Columns-sm",
		font_class: "Columns-sm",
		unicode: "eb19",
		unicode_decimal: 60185
	},
	{
		icon_id: "45671212",
		name: "Columns-xl",
		font_class: "Columns-xl",
		unicode: "eb1a",
		unicode_decimal: 60186
	},
	{
		icon_id: "45671159",
		name: "Coffee-xl",
		font_class: "Coffee-xl",
		unicode: "eb11",
		unicode_decimal: 60177
	},
	{
		icon_id: "45671157",
		name: "Coffee-sm",
		font_class: "Coffee-sm",
		unicode: "eb12",
		unicode_decimal: 60178
	},
	{
		icon_id: "45671158",
		name: "Coffee-md",
		font_class: "Coffee-md",
		unicode: "eb13",
		unicode_decimal: 60179
	},
	{
		icon_id: "45671156",
		name: "Coffee-lg",
		font_class: "Coffee-lg",
		unicode: "eb14",
		unicode_decimal: 60180
	},
	{
		icon_id: "45671155",
		name: "Coffee-xs",
		font_class: "Coffee-xs",
		unicode: "eb15",
		unicode_decimal: 60181
	},
	{
		icon_id: "45671111",
		name: "Settings2-xl",
		font_class: "Settings2-xl",
		unicode: "eb0c",
		unicode_decimal: 60172
	},
	{
		icon_id: "45671107",
		name: "Settings2-lg",
		font_class: "Settings2-lg",
		unicode: "eb0d",
		unicode_decimal: 60173
	},
	{
		icon_id: "45671108",
		name: "Settings2-sm",
		font_class: "Settings2-sm",
		unicode: "eb0e",
		unicode_decimal: 60174
	},
	{
		icon_id: "45671109",
		name: "Settings2-md",
		font_class: "Settings2-md",
		unicode: "eb0f",
		unicode_decimal: 60175
	},
	{
		icon_id: "45671110",
		name: "Settings2-xs",
		font_class: "Settings2-xs",
		unicode: "eb10",
		unicode_decimal: 60176
	},
	{
		icon_id: "45671026",
		name: "Data capture-md",
		font_class: "a-Datacapture-md",
		unicode: "eb07",
		unicode_decimal: 60167
	},
	{
		icon_id: "45671025",
		name: "Data capture-xl",
		font_class: "a-Datacapture-xl",
		unicode: "eb08",
		unicode_decimal: 60168
	},
	{
		icon_id: "45671024",
		name: "Data capture-lg",
		font_class: "a-Datacapture-lg",
		unicode: "eb09",
		unicode_decimal: 60169
	},
	{
		icon_id: "45671023",
		name: "Data capture-xs",
		font_class: "a-Datacapture-xs",
		unicode: "eb0a",
		unicode_decimal: 60170
	},
	{
		icon_id: "45671022",
		name: "Data capture-sm",
		font_class: "a-Datacapture-sm",
		unicode: "eb0b",
		unicode_decimal: 60171
	},
	{
		icon_id: "45670924",
		name: "Code-md",
		font_class: "Code-md",
		unicode: "eb02",
		unicode_decimal: 60162
	},
	{
		icon_id: "45670923",
		name: "Code-lg",
		font_class: "Code-lg",
		unicode: "eb03",
		unicode_decimal: 60163
	},
	{
		icon_id: "45670921",
		name: "Code-sm",
		font_class: "Code-sm",
		unicode: "eb04",
		unicode_decimal: 60164
	},
	{
		icon_id: "45670922",
		name: "Code-xl",
		font_class: "Code-xl",
		unicode: "eb05",
		unicode_decimal: 60165
	},
	{
		icon_id: "45670920",
		name: "Code-xs",
		font_class: "Code-xs",
		unicode: "eb06",
		unicode_decimal: 60166
	},
	{
		icon_id: "45670902",
		name: "Cloud-md",
		font_class: "Cloud-md",
		unicode: "eafd",
		unicode_decimal: 60157
	},
	{
		icon_id: "45670903",
		name: "Cloud-sm",
		font_class: "Cloud-sm",
		unicode: "eafe",
		unicode_decimal: 60158
	},
	{
		icon_id: "45670901",
		name: "Cloud-xl",
		font_class: "Cloud-xl",
		unicode: "eaff",
		unicode_decimal: 60159
	},
	{
		icon_id: "45670900",
		name: "Cloud-lg",
		font_class: "Cloud-lg",
		unicode: "eb00",
		unicode_decimal: 60160
	},
	{
		icon_id: "45670899",
		name: "Cloud-xs",
		font_class: "Cloud-xs",
		unicode: "eb01",
		unicode_decimal: 60161
	},
	{
		icon_id: "45670857",
		name: "Cloud snow-xl",
		font_class: "a-Cloudsnow-xl",
		unicode: "eaf8",
		unicode_decimal: 60152
	},
	{
		icon_id: "45670856",
		name: "Cloud snow-sm",
		font_class: "a-Cloudsnow-sm",
		unicode: "eaf9",
		unicode_decimal: 60153
	},
	{
		icon_id: "45670855",
		name: "Cloud snow-xs",
		font_class: "a-Cloudsnow-xs",
		unicode: "eafa",
		unicode_decimal: 60154
	},
	{
		icon_id: "45670854",
		name: "Cloud snow-md",
		font_class: "a-Cloudsnow-md",
		unicode: "eafb",
		unicode_decimal: 60155
	},
	{
		icon_id: "45670853",
		name: "Cloud snow-lg",
		font_class: "a-Cloudsnow-lg",
		unicode: "eafc",
		unicode_decimal: 60156
	},
	{
		icon_id: "45670747",
		name: "Cloud rain-lg",
		font_class: "a-Cloudrain-lg",
		unicode: "eaf3",
		unicode_decimal: 60147
	},
	{
		icon_id: "45670746",
		name: "Cloud rain-xl",
		font_class: "a-Cloudrain-xl",
		unicode: "eaf4",
		unicode_decimal: 60148
	},
	{
		icon_id: "45670744",
		name: "Cloud rain-md",
		font_class: "a-Cloudrain-md",
		unicode: "eaf5",
		unicode_decimal: 60149
	},
	{
		icon_id: "45670745",
		name: "Cloud rain-xs",
		font_class: "a-Cloudrain-xs",
		unicode: "eaf6",
		unicode_decimal: 60150
	},
	{
		icon_id: "45670743",
		name: "Cloud rain-sm",
		font_class: "a-Cloudrain-sm",
		unicode: "eaf7",
		unicode_decimal: 60151
	},
	{
		icon_id: "45670698",
		name: "Cloud off-md",
		font_class: "a-Cloudoff-md",
		unicode: "eaee",
		unicode_decimal: 60142
	},
	{
		icon_id: "45670697",
		name: "Cloud off-sm",
		font_class: "a-Cloudoff-sm",
		unicode: "eaef",
		unicode_decimal: 60143
	},
	{
		icon_id: "45670696",
		name: "Cloud off-xs",
		font_class: "a-Cloudoff-xs",
		unicode: "eaf0",
		unicode_decimal: 60144
	},
	{
		icon_id: "45670695",
		name: "Cloud off-xl",
		font_class: "a-Cloudoff-xl",
		unicode: "eaf1",
		unicode_decimal: 60145
	},
	{
		icon_id: "45670694",
		name: "Cloud off-lg",
		font_class: "a-Cloudoff-lg",
		unicode: "eaf2",
		unicode_decimal: 60146
	},
	{
		icon_id: "45670638",
		name: "Cloud lightning-lg",
		font_class: "a-Cloudlightning-lg",
		unicode: "eae9",
		unicode_decimal: 60137
	},
	{
		icon_id: "45670637",
		name: "Cloud lightning-xl",
		font_class: "a-Cloudlightning-xl",
		unicode: "eaea",
		unicode_decimal: 60138
	},
	{
		icon_id: "45670636",
		name: "Cloud lightning-xs",
		font_class: "a-Cloudlightning-xs",
		unicode: "eaeb",
		unicode_decimal: 60139
	},
	{
		icon_id: "45670635",
		name: "Cloud lightning-md",
		font_class: "a-Cloudlightning-md",
		unicode: "eaec",
		unicode_decimal: 60140
	},
	{
		icon_id: "45670634",
		name: "Cloud lightning-sm",
		font_class: "a-Cloudlightning-sm",
		unicode: "eaed",
		unicode_decimal: 60141
	},
	{
		icon_id: "45670599",
		name: "Cloud drizzle-xl",
		font_class: "a-Clouddrizzle-xl",
		unicode: "eae7",
		unicode_decimal: 60135
	},
	{
		icon_id: "45670598",
		name: "Cloud drizzle-lg",
		font_class: "a-Clouddrizzle-lg",
		unicode: "eae8",
		unicode_decimal: 60136
	},
	{
		icon_id: "45670602",
		name: "Cloud drizzle-md",
		font_class: "a-Clouddrizzle-md",
		unicode: "eae4",
		unicode_decimal: 60132
	},
	{
		icon_id: "45670600",
		name: "Cloud drizzle-xs",
		font_class: "a-Clouddrizzle-xs",
		unicode: "eae5",
		unicode_decimal: 60133
	},
	{
		icon_id: "45670601",
		name: "Cloud drizzle-sm",
		font_class: "a-Clouddrizzle-sm",
		unicode: "eae6",
		unicode_decimal: 60134
	},
	{
		icon_id: "45670520",
		name: "Clock-xl",
		font_class: "Clock-xl",
		unicode: "eadf",
		unicode_decimal: 60127
	},
	{
		icon_id: "45670516",
		name: "Clock-lg",
		font_class: "Clock-lg",
		unicode: "eae0",
		unicode_decimal: 60128
	},
	{
		icon_id: "45670519",
		name: "Clock-xs",
		font_class: "Clock-xs",
		unicode: "eae1",
		unicode_decimal: 60129
	},
	{
		icon_id: "45670518",
		name: "Clock-md",
		font_class: "Clock-md",
		unicode: "eae2",
		unicode_decimal: 60130
	},
	{
		icon_id: "45670517",
		name: "Clock-sm",
		font_class: "Clock-sm",
		unicode: "eae3",
		unicode_decimal: 60131
	},
	{
		icon_id: "45669925",
		name: "Clipboard-md",
		font_class: "Clipboard-md",
		unicode: "eada",
		unicode_decimal: 60122
	},
	{
		icon_id: "45669924",
		name: "Clipboard-sm",
		font_class: "Clipboard-sm",
		unicode: "eadb",
		unicode_decimal: 60123
	},
	{
		icon_id: "45669923",
		name: "Clipboard-xl",
		font_class: "Clipboard-xl",
		unicode: "eadc",
		unicode_decimal: 60124
	},
	{
		icon_id: "45669921",
		name: "Clipboard-xs",
		font_class: "Clipboard-xs",
		unicode: "eadd",
		unicode_decimal: 60125
	},
	{
		icon_id: "45669922",
		name: "Clipboard-lg",
		font_class: "Clipboard-lg",
		unicode: "eade",
		unicode_decimal: 60126
	},
	{
		icon_id: "45669880",
		name: "Circle-xl",
		font_class: "Circle-xl",
		unicode: "ead5",
		unicode_decimal: 60117
	},
	{
		icon_id: "45669876",
		name: "Circle-lg",
		font_class: "Circle-lg",
		unicode: "ead6",
		unicode_decimal: 60118
	},
	{
		icon_id: "45669878",
		name: "Circle-sm",
		font_class: "Circle-sm",
		unicode: "ead7",
		unicode_decimal: 60119
	},
	{
		icon_id: "45669879",
		name: "Circle-md",
		font_class: "Circle-md",
		unicode: "ead8",
		unicode_decimal: 60120
	},
	{
		icon_id: "45669877",
		name: "Circle-xs",
		font_class: "Circle-xs",
		unicode: "ead9",
		unicode_decimal: 60121
	},
	{
		icon_id: "45669840",
		name: "Chevrons up-lg",
		font_class: "a-Chevronsup-lg",
		unicode: "ead0",
		unicode_decimal: 60112
	},
	{
		icon_id: "45669842",
		name: "Chevrons up-xl",
		font_class: "a-Chevronsup-xl",
		unicode: "ead1",
		unicode_decimal: 60113
	},
	{
		icon_id: "45669838",
		name: "Chevrons up-xs",
		font_class: "a-Chevronsup-xs",
		unicode: "ead2",
		unicode_decimal: 60114
	},
	{
		icon_id: "45669841",
		name: "Chevrons up-md",
		font_class: "a-Chevronsup-md",
		unicode: "ead3",
		unicode_decimal: 60115
	},
	{
		icon_id: "45669839",
		name: "Chevrons up-sm",
		font_class: "a-Chevronsup-sm",
		unicode: "ead4",
		unicode_decimal: 60116
	},
	{
		icon_id: "45669854",
		name: "Chrome-md",
		font_class: "Chrome-md",
		unicode: "eacb",
		unicode_decimal: 60107
	},
	{
		icon_id: "45669855",
		name: "Chrome-lg",
		font_class: "Chrome-lg",
		unicode: "eacc",
		unicode_decimal: 60108
	},
	{
		icon_id: "45669853",
		name: "Chrome-xl",
		font_class: "Chrome-xl",
		unicode: "eacd",
		unicode_decimal: 60109
	},
	{
		icon_id: "45669852",
		name: "Chrome-xs",
		font_class: "Chrome-xs",
		unicode: "eace",
		unicode_decimal: 60110
	},
	{
		icon_id: "45669851",
		name: "Chrome-sm",
		font_class: "Chrome-sm",
		unicode: "eacf",
		unicode_decimal: 60111
	},
	{
		icon_id: "45669809",
		name: "Chevrons right-xl",
		font_class: "a-Chevronsright-xl",
		unicode: "eac6",
		unicode_decimal: 60102
	},
	{
		icon_id: "45669808",
		name: "Chevrons right-lg",
		font_class: "a-Chevronsright-lg",
		unicode: "eac7",
		unicode_decimal: 60103
	},
	{
		icon_id: "45669807",
		name: "Chevrons right-md",
		font_class: "a-Chevronsright-md",
		unicode: "eac8",
		unicode_decimal: 60104
	},
	{
		icon_id: "45669805",
		name: "Chevrons right-sm",
		font_class: "a-Chevronsright-sm",
		unicode: "eac9",
		unicode_decimal: 60105
	},
	{
		icon_id: "45669806",
		name: "Chevrons right-xs",
		font_class: "a-Chevronsright-xs",
		unicode: "eaca",
		unicode_decimal: 60106
	},
	{
		icon_id: "45669740",
		name: "Chevrons left-sm",
		font_class: "a-Chevronsleft-sm",
		unicode: "eac1",
		unicode_decimal: 60097
	},
	{
		icon_id: "45669739",
		name: "Chevrons left-md",
		font_class: "a-Chevronsleft-md",
		unicode: "eac2",
		unicode_decimal: 60098
	},
	{
		icon_id: "45669738",
		name: "Chevrons left-lg",
		font_class: "a-Chevronsleft-lg",
		unicode: "eac3",
		unicode_decimal: 60099
	},
	{
		icon_id: "45669737",
		name: "Chevrons left-xl",
		font_class: "a-Chevronsleft-xl",
		unicode: "eac4",
		unicode_decimal: 60100
	},
	{
		icon_id: "45669736",
		name: "Chevrons left-xs",
		font_class: "a-Chevronsleft-xs",
		unicode: "eac5",
		unicode_decimal: 60101
	},
	{
		icon_id: "45669640",
		name: "Chevrons down-xs",
		font_class: "a-Chevronsdown-xs",
		unicode: "eabf",
		unicode_decimal: 60095
	},
	{
		icon_id: "45669638",
		name: "Chevrons down-lg",
		font_class: "a-Chevronsdown-lg",
		unicode: "eac0",
		unicode_decimal: 60096
	},
	{
		icon_id: "45669642",
		name: "Chevrons down-xl",
		font_class: "a-Chevronsdown-xl",
		unicode: "eabc",
		unicode_decimal: 60092
	},
	{
		icon_id: "45669641",
		name: "Chevrons down-sm",
		font_class: "a-Chevronsdown-sm",
		unicode: "eabd",
		unicode_decimal: 60093
	},
	{
		icon_id: "45669639",
		name: "Chevrons down-md",
		font_class: "a-Chevronsdown-md",
		unicode: "eabe",
		unicode_decimal: 60094
	},
	{
		icon_id: "45669601",
		name: "Chevron right-xs",
		font_class: "a-Chevronright-xs",
		unicode: "eab7",
		unicode_decimal: 60087
	},
	{
		icon_id: "45669602",
		name: "Chevron right-md",
		font_class: "a-Chevronright-md",
		unicode: "eab8",
		unicode_decimal: 60088
	},
	{
		icon_id: "45669599",
		name: "Chevron right-lg",
		font_class: "a-Chevronright-lg",
		unicode: "eab9",
		unicode_decimal: 60089
	},
	{
		icon_id: "45669600",
		name: "Chevron right-xl",
		font_class: "a-Chevronright-xl",
		unicode: "eaba",
		unicode_decimal: 60090
	},
	{
		icon_id: "45669598",
		name: "Chevron right-sm",
		font_class: "a-Chevronright-sm",
		unicode: "eabb",
		unicode_decimal: 60091
	},
	{
		icon_id: "45669488",
		name: "Chevron left-lg",
		font_class: "a-Chevronleft-lg1",
		unicode: "eab2",
		unicode_decimal: 60082
	},
	{
		icon_id: "45669487",
		name: "Chevron left-sm",
		font_class: "a-Chevronleft-sm1",
		unicode: "eab3",
		unicode_decimal: 60083
	},
	{
		icon_id: "45669486",
		name: "Chevron left-xl",
		font_class: "a-Chevronleft-xl1",
		unicode: "eab4",
		unicode_decimal: 60084
	},
	{
		icon_id: "45669485",
		name: "Chevron left-xs",
		font_class: "a-Chevronleft-xs1",
		unicode: "eab5",
		unicode_decimal: 60085
	},
	{
		icon_id: "45669484",
		name: "Chevron left-md",
		font_class: "a-Chevronleft-md1",
		unicode: "eab6",
		unicode_decimal: 60086
	},
	{
		icon_id: "45669429",
		name: "Chevron left-lg",
		font_class: "a-Chevronleft-lg",
		unicode: "eaad",
		unicode_decimal: 60077
	},
	{
		icon_id: "45669426",
		name: "Chevron left-xs",
		font_class: "a-Chevronleft-xs",
		unicode: "eaae",
		unicode_decimal: 60078
	},
	{
		icon_id: "45669427",
		name: "Chevron left-xl",
		font_class: "a-Chevronleft-xl",
		unicode: "eaaf",
		unicode_decimal: 60079
	},
	{
		icon_id: "45669428",
		name: "Chevron left-md",
		font_class: "a-Chevronleft-md",
		unicode: "eab0",
		unicode_decimal: 60080
	},
	{
		icon_id: "45669425",
		name: "Chevron left-sm",
		font_class: "a-Chevronleft-sm",
		unicode: "eab1",
		unicode_decimal: 60081
	},
	{
		icon_id: "45669251",
		name: "Chevron down-lg",
		font_class: "a-Chevrondown-lg",
		unicode: "eaa8",
		unicode_decimal: 60072
	},
	{
		icon_id: "45669252",
		name: "Chevron down-sm",
		font_class: "a-Chevrondown-sm",
		unicode: "eaa9",
		unicode_decimal: 60073
	},
	{
		icon_id: "45669248",
		name: "Chevron down-xl",
		font_class: "a-Chevrondown-xl",
		unicode: "eaaa",
		unicode_decimal: 60074
	},
	{
		icon_id: "45669249",
		name: "Chevron down-md",
		font_class: "a-Chevrondown-md",
		unicode: "eaab",
		unicode_decimal: 60075
	},
	{
		icon_id: "45669250",
		name: "Chevron down-xs",
		font_class: "a-Chevrondown-xs",
		unicode: "eaac",
		unicode_decimal: 60076
	},
	{
		icon_id: "45669099",
		name: "Check-sm",
		font_class: "Check-sm",
		unicode: "eaa3",
		unicode_decimal: 60067
	},
	{
		icon_id: "45669097",
		name: "Check-xl",
		font_class: "Check-xl",
		unicode: "eaa4",
		unicode_decimal: 60068
	},
	{
		icon_id: "45669098",
		name: "Check-md",
		font_class: "Check-md",
		unicode: "eaa5",
		unicode_decimal: 60069
	},
	{
		icon_id: "45669096",
		name: "Check-xs",
		font_class: "Check-xs",
		unicode: "eaa6",
		unicode_decimal: 60070
	},
	{
		icon_id: "45669095",
		name: "Check-lg",
		font_class: "Check-lg",
		unicode: "eaa7",
		unicode_decimal: 60071
	},
	{
		icon_id: "45669050",
		name: "Check square-xl",
		font_class: "a-Checksquare-xl",
		unicode: "ea9e",
		unicode_decimal: 60062
	},
	{
		icon_id: "45669051",
		name: "Check square-lg",
		font_class: "a-Checksquare-lg",
		unicode: "ea9f",
		unicode_decimal: 60063
	},
	{
		icon_id: "45669049",
		name: "Check square-md",
		font_class: "a-Checksquare-md",
		unicode: "eaa0",
		unicode_decimal: 60064
	},
	{
		icon_id: "45669047",
		name: "Check square-xs",
		font_class: "a-Checksquare-xs",
		unicode: "eaa1",
		unicode_decimal: 60065
	},
	{
		icon_id: "45669048",
		name: "Check square-sm",
		font_class: "a-Checksquare-sm",
		unicode: "eaa2",
		unicode_decimal: 60066
	},
	{
		icon_id: "45668881",
		name: "Check circle-lg",
		font_class: "a-Checkcircle-lg",
		unicode: "ea99",
		unicode_decimal: 60057
	},
	{
		icon_id: "45668882",
		name: "Check circle-md",
		font_class: "a-Checkcircle-md",
		unicode: "ea9a",
		unicode_decimal: 60058
	},
	{
		icon_id: "45668880",
		name: "Check circle-xs",
		font_class: "a-Checkcircle-xs",
		unicode: "ea9b",
		unicode_decimal: 60059
	},
	{
		icon_id: "45668879",
		name: "Check circle-sm",
		font_class: "a-Checkcircle-sm",
		unicode: "ea9c",
		unicode_decimal: 60060
	},
	{
		icon_id: "45668878",
		name: "Check circle-xl",
		font_class: "a-Checkcircle-xl",
		unicode: "ea9d",
		unicode_decimal: 60061
	},
	{
		icon_id: "45668770",
		name: "Cast-lg",
		font_class: "Cast-lg",
		unicode: "ea94",
		unicode_decimal: 60052
	},
	{
		icon_id: "45668771",
		name: "Cast-md",
		font_class: "Cast-md",
		unicode: "ea95",
		unicode_decimal: 60053
	},
	{
		icon_id: "45668769",
		name: "Cast-sm",
		font_class: "Cast-sm",
		unicode: "ea96",
		unicode_decimal: 60054
	},
	{
		icon_id: "45668768",
		name: "Cast-xl",
		font_class: "Cast-xl",
		unicode: "ea97",
		unicode_decimal: 60055
	},
	{
		icon_id: "45668767",
		name: "Cast-xs",
		font_class: "Cast-xs",
		unicode: "ea98",
		unicode_decimal: 60056
	},
	{
		icon_id: "45668732",
		name: "Camera-xl",
		font_class: "Camera-xl",
		unicode: "ea8f",
		unicode_decimal: 60047
	},
	{
		icon_id: "45668731",
		name: "Camera-lg",
		font_class: "Camera-lg",
		unicode: "ea90",
		unicode_decimal: 60048
	},
	{
		icon_id: "45668730",
		name: "Camera-md",
		font_class: "Camera-md",
		unicode: "ea91",
		unicode_decimal: 60049
	},
	{
		icon_id: "45668733",
		name: "Camera-sm",
		font_class: "Camera-sm",
		unicode: "ea92",
		unicode_decimal: 60050
	},
	{
		icon_id: "45668729",
		name: "Camera-xs",
		font_class: "Camera-xs",
		unicode: "ea93",
		unicode_decimal: 60051
	},
	{
		icon_id: "45668619",
		name: "Camera off-sm",
		font_class: "a-Cameraoff-sm",
		unicode: "ea8a",
		unicode_decimal: 60042
	},
	{
		icon_id: "45668618",
		name: "Camera off-md",
		font_class: "a-Cameraoff-md",
		unicode: "ea8b",
		unicode_decimal: 60043
	},
	{
		icon_id: "45668617",
		name: "Camera off-lg",
		font_class: "a-Cameraoff-lg",
		unicode: "ea8c",
		unicode_decimal: 60044
	},
	{
		icon_id: "45668615",
		name: "Camera off-xs",
		font_class: "a-Cameraoff-xs",
		unicode: "ea8d",
		unicode_decimal: 60045
	},
	{
		icon_id: "45668616",
		name: "Camera off-xl",
		font_class: "a-Cameraoff-xl",
		unicode: "ea8e",
		unicode_decimal: 60046
	},
	{
		icon_id: "45668559",
		name: "Calendar-lg",
		font_class: "Calendar-lg",
		unicode: "ea85",
		unicode_decimal: 60037
	},
	{
		icon_id: "45668561",
		name: "Calendar-xl",
		font_class: "Calendar-xl",
		unicode: "ea86",
		unicode_decimal: 60038
	},
	{
		icon_id: "45668557",
		name: "Calendar-sm",
		font_class: "Calendar-sm",
		unicode: "ea87",
		unicode_decimal: 60039
	},
	{
		icon_id: "45668560",
		name: "Calendar-md",
		font_class: "Calendar-md",
		unicode: "ea88",
		unicode_decimal: 60040
	},
	{
		icon_id: "45668558",
		name: "Calendar-xs",
		font_class: "Calendar-xs",
		unicode: "ea89",
		unicode_decimal: 60041
	},
	{
		icon_id: "45668507",
		name: "Briefcase-lg",
		font_class: "Briefcase-lg",
		unicode: "ea80",
		unicode_decimal: 60032
	},
	{
		icon_id: "45668506",
		name: "Briefcase-sm",
		font_class: "Briefcase-sm",
		unicode: "ea81",
		unicode_decimal: 60033
	},
	{
		icon_id: "45668505",
		name: "Briefcase-xl",
		font_class: "Briefcase-xl",
		unicode: "ea82",
		unicode_decimal: 60034
	},
	{
		icon_id: "45668504",
		name: "Briefcase-md",
		font_class: "Briefcase-md",
		unicode: "ea83",
		unicode_decimal: 60035
	},
	{
		icon_id: "45668503",
		name: "Briefcase-xs",
		font_class: "Briefcase-xs",
		unicode: "ea84",
		unicode_decimal: 60036
	},
	{
		icon_id: "45668394",
		name: "Box-md",
		font_class: "Box-md",
		unicode: "ea7b",
		unicode_decimal: 60027
	},
	{
		icon_id: "45668393",
		name: "Box-lg",
		font_class: "Box-lg",
		unicode: "ea7c",
		unicode_decimal: 60028
	},
	{
		icon_id: "45668391",
		name: "Box-xs",
		font_class: "Box-xs",
		unicode: "ea7d",
		unicode_decimal: 60029
	},
	{
		icon_id: "45668392",
		name: "Box-sm",
		font_class: "Box-sm",
		unicode: "ea7e",
		unicode_decimal: 60030
	},
	{
		icon_id: "45668390",
		name: "Box-xl",
		font_class: "Box-xl",
		unicode: "ea7f",
		unicode_decimal: 60031
	},
	{
		icon_id: "45667986",
		name: "Bookmark-sm",
		font_class: "Bookmark-sm",
		unicode: "ea76",
		unicode_decimal: 60022
	},
	{
		icon_id: "45667987",
		name: "Bookmark-lg",
		font_class: "Bookmark-lg",
		unicode: "ea77",
		unicode_decimal: 60023
	},
	{
		icon_id: "45667983",
		name: "Bookmark-xl",
		font_class: "Bookmark-xl",
		unicode: "ea78",
		unicode_decimal: 60024
	},
	{
		icon_id: "45667985",
		name: "Bookmark-md",
		font_class: "Bookmark-md",
		unicode: "ea79",
		unicode_decimal: 60025
	},
	{
		icon_id: "45667984",
		name: "Bookmark-xs",
		font_class: "Bookmark-xs",
		unicode: "ea7a",
		unicode_decimal: 60026
	},
	{
		icon_id: "45667752",
		name: "Book-xl",
		font_class: "Book-xl",
		unicode: "ea71",
		unicode_decimal: 60017
	},
	{
		icon_id: "45667748",
		name: "Book-sm",
		font_class: "Book-sm",
		unicode: "ea72",
		unicode_decimal: 60018
	},
	{
		icon_id: "45667751",
		name: "Book-lg",
		font_class: "Book-lg",
		unicode: "ea73",
		unicode_decimal: 60019
	},
	{
		icon_id: "45667750",
		name: "Book-xs",
		font_class: "Book-xs",
		unicode: "ea74",
		unicode_decimal: 60020
	},
	{
		icon_id: "45667749",
		name: "Book-md",
		font_class: "Book-md",
		unicode: "ea75",
		unicode_decimal: 60021
	},
	{
		icon_id: "45654077",
		name: "Book open-lg",
		font_class: "a-Bookopen-lg",
		unicode: "ea6e",
		unicode_decimal: 60014
	},
	{
		icon_id: "45654079",
		name: "Book open-xs",
		font_class: "a-Bookopen-xs",
		unicode: "ea6f",
		unicode_decimal: 60015
	},
	{
		icon_id: "45654076",
		name: "Book open-md",
		font_class: "a-Bookopen-md",
		unicode: "ea70",
		unicode_decimal: 60016
	},
	{
		icon_id: "45654080",
		name: "Book open-xl",
		font_class: "a-Bookopen-xl",
		unicode: "ea6c",
		unicode_decimal: 60012
	},
	{
		icon_id: "45654078",
		name: "Book open-sm",
		font_class: "a-Bookopen-sm",
		unicode: "ea6d",
		unicode_decimal: 60013
	},
	{
		icon_id: "45653988",
		name: "Bold-md",
		font_class: "Bold-md",
		unicode: "ea67",
		unicode_decimal: 60007
	},
	{
		icon_id: "45653985",
		name: "Bold-xs",
		font_class: "Bold-xs",
		unicode: "ea68",
		unicode_decimal: 60008
	},
	{
		icon_id: "45653987",
		name: "Bold-lg",
		font_class: "Bold-lg",
		unicode: "ea69",
		unicode_decimal: 60009
	},
	{
		icon_id: "45653986",
		name: "Bold-xl",
		font_class: "Bold-xl",
		unicode: "ea6a",
		unicode_decimal: 60010
	},
	{
		icon_id: "45653984",
		name: "Bold-sm",
		font_class: "Bold-sm",
		unicode: "ea6b",
		unicode_decimal: 60011
	},
	{
		icon_id: "45653788",
		name: "Bluetooth-sm",
		font_class: "Bluetooth-sm",
		unicode: "ea62",
		unicode_decimal: 60002
	},
	{
		icon_id: "45653784",
		name: "Bluetooth-xs",
		font_class: "Bluetooth-xs",
		unicode: "ea63",
		unicode_decimal: 60003
	},
	{
		icon_id: "45653787",
		name: "Bluetooth-xl",
		font_class: "Bluetooth-xl",
		unicode: "ea64",
		unicode_decimal: 60004
	},
	{
		icon_id: "45653785",
		name: "Bluetooth-md",
		font_class: "Bluetooth-md",
		unicode: "ea65",
		unicode_decimal: 60005
	},
	{
		icon_id: "45653786",
		name: "Bluetooth-lg",
		font_class: "Bluetooth-lg",
		unicode: "ea66",
		unicode_decimal: 60006
	},
	{
		icon_id: "45653553",
		name: "Bell off-xl",
		font_class: "a-Belloff-xl",
		unicode: "ea60",
		unicode_decimal: 60000
	},
	{
		icon_id: "45653551",
		name: "Bell off-lg",
		font_class: "a-Belloff-lg",
		unicode: "ea61",
		unicode_decimal: 60001
	},
	{
		icon_id: "45653555",
		name: "Bell off-xs",
		font_class: "a-Belloff-xs",
		unicode: "ea5d",
		unicode_decimal: 59997
	},
	{
		icon_id: "45653554",
		name: "Bell off-sm",
		font_class: "a-Belloff-sm",
		unicode: "ea5e",
		unicode_decimal: 59998
	},
	{
		icon_id: "45653552",
		name: "Bell off-md",
		font_class: "a-Belloff-md",
		unicode: "ea5f",
		unicode_decimal: 59999
	},
	{
		icon_id: "45653701",
		name: "Bell-md",
		font_class: "Bell-md",
		unicode: "ea58",
		unicode_decimal: 59992
	},
	{
		icon_id: "45653699",
		name: "Bell-xl",
		font_class: "Bell-xl",
		unicode: "ea59",
		unicode_decimal: 59993
	},
	{
		icon_id: "45653700",
		name: "Bell-sm",
		font_class: "Bell-sm",
		unicode: "ea5a",
		unicode_decimal: 59994
	},
	{
		icon_id: "45653697",
		name: "Bell-lg",
		font_class: "Bell-lg",
		unicode: "ea5b",
		unicode_decimal: 59995
	},
	{
		icon_id: "45653698",
		name: "Bell-xs",
		font_class: "Bell-xs",
		unicode: "ea5c",
		unicode_decimal: 59996
	},
	{
		icon_id: "45653175",
		name: "Battery-lg",
		font_class: "Battery-lg",
		unicode: "ea53",
		unicode_decimal: 59987
	},
	{
		icon_id: "45653173",
		name: "Battery-sm",
		font_class: "Battery-sm",
		unicode: "ea54",
		unicode_decimal: 59988
	},
	{
		icon_id: "45653174",
		name: "Battery-md",
		font_class: "Battery-md",
		unicode: "ea55",
		unicode_decimal: 59989
	},
	{
		icon_id: "45653171",
		name: "Battery-xs",
		font_class: "Battery-xs",
		unicode: "ea56",
		unicode_decimal: 59990
	},
	{
		icon_id: "45653172",
		name: "Battery-xl",
		font_class: "Battery-xl",
		unicode: "ea57",
		unicode_decimal: 59991
	},
	{
		icon_id: "45652841",
		name: "Bar chart-lg",
		font_class: "a-Barchart-lg",
		unicode: "ea4e",
		unicode_decimal: 59982
	},
	{
		icon_id: "45652843",
		name: "Bar chart-xs",
		font_class: "a-Barchart-xs",
		unicode: "ea4f",
		unicode_decimal: 59983
	},
	{
		icon_id: "45652840",
		name: "Bar chart-xl",
		font_class: "a-Barchart-xl",
		unicode: "ea50",
		unicode_decimal: 59984
	},
	{
		icon_id: "45652842",
		name: "Bar chart-sm",
		font_class: "a-Barchart-sm",
		unicode: "ea51",
		unicode_decimal: 59985
	},
	{
		icon_id: "45652839",
		name: "Bar chart-md",
		font_class: "a-Barchart-md",
		unicode: "ea52",
		unicode_decimal: 59986
	},
	{
		icon_id: "45653028",
		name: "Battery charging-lg",
		font_class: "a-Batterycharging-lg",
		unicode: "ea49",
		unicode_decimal: 59977
	},
	{
		icon_id: "45653026",
		name: "Battery charging-md",
		font_class: "a-Batterycharging-md",
		unicode: "ea4a",
		unicode_decimal: 59978
	},
	{
		icon_id: "45653027",
		name: "Battery charging-sm",
		font_class: "a-Batterycharging-sm",
		unicode: "ea4b",
		unicode_decimal: 59979
	},
	{
		icon_id: "45653025",
		name: "Battery charging-xs",
		font_class: "a-Batterycharging-xs",
		unicode: "ea4c",
		unicode_decimal: 59980
	},
	{
		icon_id: "45653024",
		name: "Battery charging-xl",
		font_class: "a-Batterycharging-xl",
		unicode: "ea4d",
		unicode_decimal: 59981
	},
	{
		icon_id: "45652732",
		name: "Bar chart2-sm",
		font_class: "a-Barchart2-sm",
		unicode: "ea44",
		unicode_decimal: 59972
	},
	{
		icon_id: "45652733",
		name: "Bar chart2-md",
		font_class: "a-Barchart2-md",
		unicode: "ea45",
		unicode_decimal: 59973
	},
	{
		icon_id: "45652734",
		name: "Bar chart2-xl",
		font_class: "a-Barchart2-xl",
		unicode: "ea46",
		unicode_decimal: 59974
	},
	{
		icon_id: "45652735",
		name: "Bar chart2-xs",
		font_class: "a-Barchart2-xs",
		unicode: "ea47",
		unicode_decimal: 59975
	},
	{
		icon_id: "45652736",
		name: "Bar chart2-lg",
		font_class: "a-Barchart2-lg",
		unicode: "ea48",
		unicode_decimal: 59976
	},
	{
		icon_id: "45652660",
		name: "Award-lg",
		font_class: "Award-lg",
		unicode: "ea43",
		unicode_decimal: 59971
	},
	{
		icon_id: "45652662",
		name: "Award-xs",
		font_class: "Award-xs",
		unicode: "ea3f",
		unicode_decimal: 59967
	},
	{
		icon_id: "45652661",
		name: "Award-xl",
		font_class: "Award-xl",
		unicode: "ea40",
		unicode_decimal: 59968
	},
	{
		icon_id: "45652658",
		name: "Award-md",
		font_class: "Award-md",
		unicode: "ea41",
		unicode_decimal: 59969
	},
	{
		icon_id: "45652659",
		name: "Award-sm",
		font_class: "Award-sm",
		unicode: "ea42",
		unicode_decimal: 59970
	},
	{
		icon_id: "45652577",
		name: "At sign-md",
		font_class: "a-Atsign-md",
		unicode: "ea3a",
		unicode_decimal: 59962
	},
	{
		icon_id: "45652578",
		name: "At sign-xl",
		font_class: "a-Atsign-xl",
		unicode: "ea3b",
		unicode_decimal: 59963
	},
	{
		icon_id: "45652576",
		name: "At sign-sm",
		font_class: "a-Atsign-sm",
		unicode: "ea3c",
		unicode_decimal: 59964
	},
	{
		icon_id: "45652575",
		name: "At sign-xs",
		font_class: "a-Atsign-xs",
		unicode: "ea3d",
		unicode_decimal: 59965
	},
	{
		icon_id: "45652574",
		name: "At sign-lg",
		font_class: "a-Atsign-lg",
		unicode: "ea3e",
		unicode_decimal: 59966
	},
	{
		icon_id: "45652415",
		name: "Arrow up-right-xs",
		font_class: "a-Arrowup-right-xs",
		unicode: "ea35",
		unicode_decimal: 59957
	},
	{
		icon_id: "45652416",
		name: "Arrow up-right-sm",
		font_class: "a-Arrowup-right-sm",
		unicode: "ea36",
		unicode_decimal: 59958
	},
	{
		icon_id: "45652414",
		name: "Arrow up-right-lg",
		font_class: "a-Arrowup-right-lg",
		unicode: "ea37",
		unicode_decimal: 59959
	},
	{
		icon_id: "45652413",
		name: "Arrow up-right-xl",
		font_class: "a-Arrowup-right-xl",
		unicode: "ea38",
		unicode_decimal: 59960
	},
	{
		icon_id: "45652412",
		name: "Arrow up-right-md",
		font_class: "a-Arrowup-right-md",
		unicode: "ea39",
		unicode_decimal: 59961
	},
	{
		icon_id: "45652339",
		name: "Arrow up-xl",
		font_class: "a-Arrowup-xl",
		unicode: "ea30",
		unicode_decimal: 59952
	},
	{
		icon_id: "45652341",
		name: "Arrow up-md",
		font_class: "a-Arrowup-md",
		unicode: "ea31",
		unicode_decimal: 59953
	},
	{
		icon_id: "45652340",
		name: "Arrow up-sm",
		font_class: "a-Arrowup-sm",
		unicode: "ea32",
		unicode_decimal: 59954
	},
	{
		icon_id: "45652338",
		name: "Arrow up-lg",
		font_class: "a-Arrowup-lg",
		unicode: "ea33",
		unicode_decimal: 59955
	},
	{
		icon_id: "45652337",
		name: "Arrow up-xs",
		font_class: "a-Arrowup-xs",
		unicode: "ea34",
		unicode_decimal: 59956
	},
	{
		icon_id: "45652306",
		name: "Arrow up-left-sm",
		font_class: "a-Arrowup-left-sm",
		unicode: "ea2b",
		unicode_decimal: 59947
	},
	{
		icon_id: "45652304",
		name: "Arrow up-left-xl",
		font_class: "a-Arrowup-left-xl",
		unicode: "ea2c",
		unicode_decimal: 59948
	},
	{
		icon_id: "45652305",
		name: "Arrow up-left-xs",
		font_class: "a-Arrowup-left-xs",
		unicode: "ea2d",
		unicode_decimal: 59949
	},
	{
		icon_id: "45652303",
		name: "Arrow up-left-lg",
		font_class: "a-Arrowup-left-lg",
		unicode: "ea2e",
		unicode_decimal: 59950
	},
	{
		icon_id: "45652302",
		name: "Arrow up-left-md",
		font_class: "a-Arrowup-left-md",
		unicode: "ea2f",
		unicode_decimal: 59951
	},
	{
		icon_id: "45652175",
		name: "Arrow up-circle-xs",
		font_class: "a-Arrowup-circle-xs",
		unicode: "ea27",
		unicode_decimal: 59943
	},
	{
		icon_id: "45652174",
		name: "Arrow up-circle-md",
		font_class: "a-Arrowup-circle-md",
		unicode: "ea28",
		unicode_decimal: 59944
	},
	{
		icon_id: "45652173",
		name: "Arrow up-circle-xl",
		font_class: "a-Arrowup-circle-xl",
		unicode: "ea29",
		unicode_decimal: 59945
	},
	{
		icon_id: "45652172",
		name: "Arrow up-circle-lg",
		font_class: "a-Arrowup-circle-lg",
		unicode: "ea2a",
		unicode_decimal: 59946
	},
	{
		icon_id: "45652176",
		name: "Arrow up-circle-sm",
		font_class: "a-Arrowup-circle-sm",
		unicode: "ea26",
		unicode_decimal: 59942
	},
	{
		icon_id: "45652145",
		name: "Arrow right-xs",
		font_class: "a-Arrowright-xs",
		unicode: "ea21",
		unicode_decimal: 59937
	},
	{
		icon_id: "45652146",
		name: "Arrow right-lg",
		font_class: "a-Arrowright-lg",
		unicode: "ea22",
		unicode_decimal: 59938
	},
	{
		icon_id: "45652147",
		name: "Arrow right-sm",
		font_class: "a-Arrowright-sm",
		unicode: "ea23",
		unicode_decimal: 59939
	},
	{
		icon_id: "45652144",
		name: "Arrow right-xl",
		font_class: "a-Arrowright-xl",
		unicode: "ea24",
		unicode_decimal: 59940
	},
	{
		icon_id: "45652143",
		name: "Arrow right-md",
		font_class: "a-Arrowright-md",
		unicode: "ea25",
		unicode_decimal: 59941
	},
	{
		icon_id: "45652081",
		name: "Arrow right-circle-sm",
		font_class: "a-Arrowright-circle-sm",
		unicode: "ea1c",
		unicode_decimal: 59932
	},
	{
		icon_id: "45652080",
		name: "Arrow right-circle-xl",
		font_class: "a-Arrowright-circle-xl",
		unicode: "ea1d",
		unicode_decimal: 59933
	},
	{
		icon_id: "45652079",
		name: "Arrow right-circle-md",
		font_class: "a-Arrowright-circle-md",
		unicode: "ea1e",
		unicode_decimal: 59934
	},
	{
		icon_id: "45652078",
		name: "Arrow right-circle-xs",
		font_class: "a-Arrowright-circle-xs",
		unicode: "ea1f",
		unicode_decimal: 59935
	},
	{
		icon_id: "45652077",
		name: "Arrow right-circle-lg",
		font_class: "a-Arrowright-circle-lg",
		unicode: "ea20",
		unicode_decimal: 59936
	},
	{
		icon_id: "45652042",
		name: "Arrow left-sm",
		font_class: "a-Arrowleft-sm",
		unicode: "ea17",
		unicode_decimal: 59927
	},
	{
		icon_id: "45652043",
		name: "Arrow left-md",
		font_class: "a-Arrowleft-md",
		unicode: "ea18",
		unicode_decimal: 59928
	},
	{
		icon_id: "45652044",
		name: "Arrow left-lg",
		font_class: "a-Arrowleft-lg",
		unicode: "ea19",
		unicode_decimal: 59929
	},
	{
		icon_id: "45652041",
		name: "Arrow left-xl",
		font_class: "a-Arrowleft-xl",
		unicode: "ea1a",
		unicode_decimal: 59930
	},
	{
		icon_id: "45652040",
		name: "Arrow left-xs",
		font_class: "a-Arrowleft-xs",
		unicode: "ea1b",
		unicode_decimal: 59931
	},
	{
		icon_id: "45651994",
		name: "Arrow left-circle-xl",
		font_class: "a-Arrowleft-circle-xl",
		unicode: "ea12",
		unicode_decimal: 59922
	},
	{
		icon_id: "45651993",
		name: "Arrow left-circle-sm",
		font_class: "a-Arrowleft-circle-sm",
		unicode: "ea13",
		unicode_decimal: 59923
	},
	{
		icon_id: "45651992",
		name: "Arrow left-circle-md",
		font_class: "a-Arrowleft-circle-md",
		unicode: "ea14",
		unicode_decimal: 59924
	},
	{
		icon_id: "45651991",
		name: "Arrow left-circle-xs",
		font_class: "a-Arrowleft-circle-xs",
		unicode: "ea15",
		unicode_decimal: 59925
	},
	{
		icon_id: "45651990",
		name: "Arrow left-circle-lg",
		font_class: "a-Arrowleft-circle-lg",
		unicode: "ea16",
		unicode_decimal: 59926
	},
	{
		icon_id: "45651898",
		name: "Arrow down-xl",
		font_class: "a-Arrowdown-xl",
		unicode: "ea0d",
		unicode_decimal: 59917
	},
	{
		icon_id: "45651895",
		name: "Arrow down-sm",
		font_class: "a-Arrowdown-sm",
		unicode: "ea0e",
		unicode_decimal: 59918
	},
	{
		icon_id: "45651897",
		name: "Arrow down-xs",
		font_class: "a-Arrowdown-xs",
		unicode: "ea0f",
		unicode_decimal: 59919
	},
	{
		icon_id: "45651896",
		name: "Arrow down-md",
		font_class: "a-Arrowdown-md",
		unicode: "ea10",
		unicode_decimal: 59920
	},
	{
		icon_id: "45651894",
		name: "Arrow down-lg",
		font_class: "a-Arrowdown-lg",
		unicode: "ea11",
		unicode_decimal: 59921
	},
	{
		icon_id: "45651774",
		name: "Arrow down-right-sm",
		font_class: "a-Arrowdown-right-sm",
		unicode: "ea0c",
		unicode_decimal: 59916
	},
	{
		icon_id: "45651772",
		name: "Arrow down-right-xl",
		font_class: "a-Arrowdown-right-xl",
		unicode: "ea08",
		unicode_decimal: 59912
	},
	{
		icon_id: "45651771",
		name: "Arrow down-right-md",
		font_class: "a-Arrowdown-right-md",
		unicode: "ea09",
		unicode_decimal: 59913
	},
	{
		icon_id: "45651775",
		name: "Arrow down-right-xs",
		font_class: "a-Arrowdown-right-xs",
		unicode: "ea0a",
		unicode_decimal: 59914
	},
	{
		icon_id: "45651773",
		name: "Arrow down-right-lg",
		font_class: "a-Arrowdown-right-lg",
		unicode: "ea0b",
		unicode_decimal: 59915
	},
	{
		icon_id: "45651632",
		name: "Arrow down-left-sm",
		font_class: "a-Arrowdown-left-sm",
		unicode: "ea03",
		unicode_decimal: 59907
	},
	{
		icon_id: "45651633",
		name: "Arrow down-left-xl",
		font_class: "a-Arrowdown-left-xl",
		unicode: "ea04",
		unicode_decimal: 59908
	},
	{
		icon_id: "45651634",
		name: "Arrow down-left-xs",
		font_class: "a-Arrowdown-left-xs",
		unicode: "ea05",
		unicode_decimal: 59909
	},
	{
		icon_id: "45651631",
		name: "Arrow down-left-md",
		font_class: "a-Arrowdown-left-md",
		unicode: "ea06",
		unicode_decimal: 59910
	},
	{
		icon_id: "45651630",
		name: "Arrow down-left-lg",
		font_class: "a-Arrowdown-left-lg",
		unicode: "ea07",
		unicode_decimal: 59911
	},
	{
		icon_id: "45651520",
		name: "Arrow down-circle-sm",
		font_class: "a-Arrowdown-circle-sm",
		unicode: "e9fe",
		unicode_decimal: 59902
	},
	{
		icon_id: "45651519",
		name: "Arrow down-circle-md",
		font_class: "a-Arrowdown-circle-md",
		unicode: "e9ff",
		unicode_decimal: 59903
	},
	{
		icon_id: "45651516",
		name: "Arrow down-circle-lg",
		font_class: "a-Arrowdown-circle-lg",
		unicode: "ea00",
		unicode_decimal: 59904
	},
	{
		icon_id: "45651518",
		name: "Arrow down-circle-xs",
		font_class: "a-Arrowdown-circle-xs",
		unicode: "ea01",
		unicode_decimal: 59905
	},
	{
		icon_id: "45651517",
		name: "Arrow down-circle-xl",
		font_class: "a-Arrowdown-circle-xl",
		unicode: "ea02",
		unicode_decimal: 59906
	},
	{
		icon_id: "45651476",
		name: "Archive-md",
		font_class: "Archive-md",
		unicode: "e9f9",
		unicode_decimal: 59897
	},
	{
		icon_id: "45651475",
		name: "Archive-xl",
		font_class: "Archive-xl",
		unicode: "e9fa",
		unicode_decimal: 59898
	},
	{
		icon_id: "45651472",
		name: "Archive-lg",
		font_class: "Archive-lg",
		unicode: "e9fb",
		unicode_decimal: 59899
	},
	{
		icon_id: "45651473",
		name: "Archive-xs",
		font_class: "Archive-xs",
		unicode: "e9fc",
		unicode_decimal: 59900
	},
	{
		icon_id: "45651474",
		name: "Archive-sm",
		font_class: "Archive-sm",
		unicode: "e9fd",
		unicode_decimal: 59901
	},
	{
		icon_id: "45651443",
		name: "Aperture-md",
		font_class: "Aperture-md",
		unicode: "e9f4",
		unicode_decimal: 59892
	},
	{
		icon_id: "45651440",
		name: "Aperture-lg",
		font_class: "Aperture-lg",
		unicode: "e9f5",
		unicode_decimal: 59893
	},
	{
		icon_id: "45651441",
		name: "Aperture-sm",
		font_class: "Aperture-sm",
		unicode: "e9f6",
		unicode_decimal: 59894
	},
	{
		icon_id: "45651442",
		name: "Aperture-xl",
		font_class: "Aperture-xl",
		unicode: "e9f7",
		unicode_decimal: 59895
	},
	{
		icon_id: "45651439",
		name: "Aperture-xs",
		font_class: "Aperture-xs",
		unicode: "e9f8",
		unicode_decimal: 59896
	},
	{
		icon_id: "45651170",
		name: "Anchor-xs",
		font_class: "Anchor-xs",
		unicode: "e9ef",
		unicode_decimal: 59887
	},
	{
		icon_id: "45651169",
		name: "Anchor-md",
		font_class: "Anchor-md",
		unicode: "e9f0",
		unicode_decimal: 59888
	},
	{
		icon_id: "45651167",
		name: "Anchor-xl",
		font_class: "Anchor-xl",
		unicode: "e9f1",
		unicode_decimal: 59889
	},
	{
		icon_id: "45651168",
		name: "Anchor-lg",
		font_class: "Anchor-lg",
		unicode: "e9f2",
		unicode_decimal: 59890
	},
	{
		icon_id: "45651166",
		name: "Anchor-sm",
		font_class: "Anchor-sm",
		unicode: "e9f3",
		unicode_decimal: 59891
	},
	{
		icon_id: "45651103",
		name: "Align right-xs",
		font_class: "a-Alignright-xs",
		unicode: "e9ea",
		unicode_decimal: 59882
	},
	{
		icon_id: "45651102",
		name: "Align right-sm",
		font_class: "a-Alignright-sm",
		unicode: "e9eb",
		unicode_decimal: 59883
	},
	{
		icon_id: "45651101",
		name: "Align right-xl",
		font_class: "a-Alignright-xl",
		unicode: "e9ec",
		unicode_decimal: 59884
	},
	{
		icon_id: "45651099",
		name: "Align right-md",
		font_class: "a-Alignright-md",
		unicode: "e9ed",
		unicode_decimal: 59885
	},
	{
		icon_id: "45651100",
		name: "Align right-lg",
		font_class: "a-Alignright-lg",
		unicode: "e9ee",
		unicode_decimal: 59886
	},
	{
		icon_id: "45651061",
		name: "Align left-md",
		font_class: "a-Alignleft-md",
		unicode: "e9e8",
		unicode_decimal: 59880
	},
	{
		icon_id: "45651057",
		name: "Align left-lg",
		font_class: "a-Alignleft-lg",
		unicode: "e9e9",
		unicode_decimal: 59881
	},
	{
		icon_id: "45651060",
		name: "Align left-xs",
		font_class: "a-Alignleft-xs",
		unicode: "e9e5",
		unicode_decimal: 59877
	},
	{
		icon_id: "45651059",
		name: "Align left-xl",
		font_class: "a-Alignleft-xl",
		unicode: "e9e6",
		unicode_decimal: 59878
	},
	{
		icon_id: "45651058",
		name: "Align left-sm",
		font_class: "a-Alignleft-sm",
		unicode: "e9e7",
		unicode_decimal: 59879
	},
	{
		icon_id: "45650986",
		name: "Align justify-xl",
		font_class: "a-Alignjustify-xl",
		unicode: "e9e0",
		unicode_decimal: 59872
	},
	{
		icon_id: "45650985",
		name: "Align justify-md",
		font_class: "a-Alignjustify-md",
		unicode: "e9e1",
		unicode_decimal: 59873
	},
	{
		icon_id: "45650982",
		name: "Align justify-xs",
		font_class: "a-Alignjustify-xs",
		unicode: "e9e2",
		unicode_decimal: 59874
	},
	{
		icon_id: "45650984",
		name: "Align justify-lg",
		font_class: "a-Alignjustify-lg",
		unicode: "e9e3",
		unicode_decimal: 59875
	},
	{
		icon_id: "45650983",
		name: "Align justify-sm",
		font_class: "a-Alignjustify-sm",
		unicode: "e9e4",
		unicode_decimal: 59876
	},
	{
		icon_id: "45650930",
		name: "Align center-md",
		font_class: "a-Aligncenter-md",
		unicode: "e9db",
		unicode_decimal: 59867
	},
	{
		icon_id: "45650929",
		name: "Align center-lg",
		font_class: "a-Aligncenter-lg",
		unicode: "e9dc",
		unicode_decimal: 59868
	},
	{
		icon_id: "45650931",
		name: "Align center-sm",
		font_class: "a-Aligncenter-sm",
		unicode: "e9dd",
		unicode_decimal: 59869
	},
	{
		icon_id: "45650928",
		name: "Align center-xs",
		font_class: "a-Aligncenter-xs",
		unicode: "e9de",
		unicode_decimal: 59870
	},
	{
		icon_id: "45650927",
		name: "Align center-xl",
		font_class: "a-Aligncenter-xl",
		unicode: "e9df",
		unicode_decimal: 59871
	},
	{
		icon_id: "45650857",
		name: "Alert triangle-sm",
		font_class: "a-Alerttriangle-sm",
		unicode: "e9d9",
		unicode_decimal: 59865
	},
	{
		icon_id: "45650856",
		name: "Alert triangle-lg",
		font_class: "a-Alerttriangle-lg",
		unicode: "e9da",
		unicode_decimal: 59866
	},
	{
		icon_id: "45650860",
		name: "Alert triangle-xl",
		font_class: "a-Alerttriangle-xl",
		unicode: "e9d6",
		unicode_decimal: 59862
	},
	{
		icon_id: "45650859",
		name: "Alert triangle-md",
		font_class: "a-Alerttriangle-md",
		unicode: "e9d7",
		unicode_decimal: 59863
	},
	{
		icon_id: "45650858",
		name: "Alert triangle-xs",
		font_class: "a-Alerttriangle-xs",
		unicode: "e9d8",
		unicode_decimal: 59864
	},
	{
		icon_id: "45650791",
		name: "Alert octagon-md",
		font_class: "a-Alertoctagon-md",
		unicode: "e9d1",
		unicode_decimal: 59857
	},
	{
		icon_id: "45650790",
		name: "Alert octagon-sm",
		font_class: "a-Alertoctagon-sm",
		unicode: "e9d2",
		unicode_decimal: 59858
	},
	{
		icon_id: "45650789",
		name: "Alert octagon-xl",
		font_class: "a-Alertoctagon-xl",
		unicode: "e9d3",
		unicode_decimal: 59859
	},
	{
		icon_id: "45650788",
		name: "Alert octagon-lg",
		font_class: "a-Alertoctagon-lg",
		unicode: "e9d4",
		unicode_decimal: 59860
	},
	{
		icon_id: "45650787",
		name: "Alert octagon-xs",
		font_class: "a-Alertoctagon-xs",
		unicode: "e9d5",
		unicode_decimal: 59861
	},
	{
		icon_id: "45650664",
		name: "Alert circle-md",
		font_class: "a-Alertcircle-md",
		unicode: "e9cc",
		unicode_decimal: 59852
	},
	{
		icon_id: "45650663",
		name: "Alert circle-xl",
		font_class: "a-Alertcircle-xl",
		unicode: "e9cd",
		unicode_decimal: 59853
	},
	{
		icon_id: "45650662",
		name: "Alert circle-sm",
		font_class: "a-Alertcircle-sm",
		unicode: "e9ce",
		unicode_decimal: 59854
	},
	{
		icon_id: "45650660",
		name: "Alert circle-lg",
		font_class: "a-Alertcircle-lg",
		unicode: "e9cf",
		unicode_decimal: 59855
	},
	{
		icon_id: "45650661",
		name: "Alert circle-xs",
		font_class: "a-Alertcircle-xs",
		unicode: "e9d0",
		unicode_decimal: 59856
	},
	{
		icon_id: "45650404",
		name: "Airplay-xl",
		font_class: "Airplay-xl",
		unicode: "e9c7",
		unicode_decimal: 59847
	},
	{
		icon_id: "45650403",
		name: "Airplay-xs",
		font_class: "Airplay-xs",
		unicode: "e9c8",
		unicode_decimal: 59848
	},
	{
		icon_id: "45650400",
		name: "Airplay-lg",
		font_class: "Airplay-lg",
		unicode: "e9c9",
		unicode_decimal: 59849
	},
	{
		icon_id: "45650402",
		name: "Airplay-sm",
		font_class: "Airplay-sm",
		unicode: "e9ca",
		unicode_decimal: 59850
	},
	{
		icon_id: "45650401",
		name: "Airplay-md",
		font_class: "Airplay-md",
		unicode: "e9cb",
		unicode_decimal: 59851
	},
	{
		icon_id: "45650287",
		name: "Activity_xl",
		font_class: "Activity_xl",
		unicode: "e9c3",
		unicode_decimal: 59843
	},
	{
		icon_id: "45650286",
		name: "Activity_md",
		font_class: "Activity_md",
		unicode: "e9c2",
		unicode_decimal: 59842
	},
	{
		icon_id: "45650285",
		name: "Activity_lg",
		font_class: "Activity_lg",
		unicode: "e9c4",
		unicode_decimal: 59844
	},
	{
		icon_id: "45650284",
		name: "Activity_sm",
		font_class: "Activity_sm",
		unicode: "e9c5",
		unicode_decimal: 59845
	},
	{
		icon_id: "45650283",
		name: "Activity_xs",
		font_class: "Activity_xs",
		unicode: "e9c6",
		unicode_decimal: 59846
	}
];
var iconfontJson = {
	id: id,
	name: name,
	font_family: font_family,
	css_prefix_text: css_prefix_text,
	description: description,
	glyphs: glyphs
};

/** 同一图层名重复出现时直接命中，避免反复 find 整表 */
const iconfontClassCache = new Map();
function cleanString(str) {
    return str.replaceAll(/[*#_\s-]/g, '').toLowerCase();
}
const ICON_SIZE_TOKEN_RE = /^(?:xs|sm|md|lg|xl|2xl|3xl|xxl)$/i;
/** 去掉名末尾的尺寸缀（Figma / iconfont 命名如 xxx-xs、xxx-md），再参与匹配 */
function stripTrailingIconSizeTokens(str) {
    let s = str.trim();
    const suffixRe = /[-_/](?:xs|sm|md|lg|xl|2xl|3xl|xxl)$/i;
    while (suffixRe.test(s)) {
        const next = s.replace(suffixRe, '');
        if (next === s)
            break;
        s = next.trim();
    }
    return s;
}
/**
 * 从图标 INSTANCE 的 `componentProperties`（如 Size: "16-sm"）解析尺寸档，用于 iconfont 优先按规格匹配。
 */
function extractIconVariantSizeToken(node) {
    if (!node || typeof node !== 'object')
        return undefined;
    const n = node;
    if (n.type !== 'INSTANCE')
        return undefined;
    const props = n.componentProperties;
    if (!props || typeof props !== 'object')
        return undefined;
    const sizeEntry = props.Size ?? props['尺寸'] ?? props.size;
    const value = sizeEntry?.value;
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    const parts = value.trim().split(/[-_/]/);
    const last = parts[parts.length - 1] ?? '';
    if (ICON_SIZE_TOKEN_RE.test(last))
        return last.toLowerCase();
    return undefined;
}
function normalizedIconMatchKey(raw) {
    return cleanString(raw);
}
/**
 * @param nameForMatch 图层名（如 Help circle）
 * @param sourceNode 可选；若为带 `componentProperties.Size` 的 INSTANCE（如 16-sm），优先按「名-尺寸档」匹配 glyph，再回退为去掉尺寸缀的匹配
 */
function getIconFontClassName(nameForMatch, sourceNode) {
    if (!nameForMatch || typeof nameForMatch !== 'string')
        return undefined;
    const sizeToken = extractIconVariantSizeToken(sourceNode);
    const cacheKey = `${nameForMatch}\0${sizeToken ?? ''}`;
    if (iconfontClassCache.has(cacheKey)) {
        return iconfontClassCache.get(cacheKey);
    }
    const { glyphs } = iconfontJson;
    const baseName = stripTrailingIconSizeTokens(nameForMatch.trim());
    if (sizeToken) {
        const sizedCandidate = `${baseName}-${sizeToken}`;
        const sizedKey = normalizedIconMatchKey(sizedCandidate);
        const sizedHit = glyphs.find((g) => normalizedIconMatchKey(g.name) === sizedKey);
        if (sizedHit?.font_class) {
            const result = `icon-${sizedHit.font_class}`;
            iconfontClassCache.set(cacheKey, result);
            return result;
        }
    }
    const fallbackKey = normalizedIconMatchKey(stripTrailingIconSizeTokens(nameForMatch));
    const item = glyphs.find((g) => normalizedIconMatchKey(stripTrailingIconSizeTokens(g.name)) === fallbackKey);
    const result = item?.font_class ? `icon-${item.font_class}` : undefined;
    iconfontClassCache.set(cacheKey, result);
    return result;
}
/**
 * 工具函数
 */
/**
 * 将颜色对象转换为 rgba 字符串
 */
function rgbaString(color, overrideAlpha) {
    const alpha = typeof overrideAlpha === 'number' ? overrideAlpha : typeof color.a === 'number' ? color.a : 1;
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `rgba(${r},${g},${b},${Number(alpha.toFixed(3))})`;
}
/** 0–1 → 百分比字符串，保留与 Figma Dev Mode 接近的小数位 */
function formatGradientStopPercent(position) {
    const p = position * 100;
    const rounded = Math.round(p * 100) / 100;
    return `${rounded}%`;
}
function multiplyStopAlpha(color, paintOpacity) {
    const baseA = typeof color.a === 'number' ? color.a : 1;
    const po = typeof paintOpacity === 'number' ? paintOpacity : 1;
    return { ...color, a: baseA * po };
}
/** 渐变色标：与 Figma Dev Mode 接近（逗号后空格、alpha 两位小数） */
function rgbaStringGradientStop(color, overrideAlpha) {
    const alpha = typeof overrideAlpha === 'number'
        ? overrideAlpha
        : typeof color.a === 'number'
            ? color.a
            : 1;
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    const a = Number(alpha.toFixed(2));
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}
/**
 * 不透明实色 → `#RRGGBB`，否则 rgba（用于多层 background 与设计稿对齐）
 */
function solidPaintToCss(fill) {
    if (!fill || fill.type !== 'SOLID' || !fill.color)
        return undefined;
    const c = multiplyStopAlpha(fill.color, fill.opacity);
    const a = c.a;
    if (a >= 0.999) {
        const r = Math.round(c.r * 255);
        const g = Math.round(c.g * 255);
        const b = Math.round(c.b * 255);
        const h = (n) => n.toString(16).padStart(2, '0');
        return `#${h(r)}${h(g)}${h(b)}`;
    }
    return rgbaString(fill.color, fill.opacity);
}
/**
 * Figma `fills` 自下而上叠放（数组首项为最底层）；CSS `background` 逗号分隔时**先写的层在最上**。
 * 故与浏览器一致需 **reverse**。
 */
function pickFillArray(node) {
    if (Array.isArray(node.fills) && node.fills.length > 0)
        return node.fills;
    if (Array.isArray(node.background) && node.background.length > 0)
        return node.background;
    return [];
}
/**
 * 径向渐变：用三个 handle（归一化对象坐标 0–1）估算 CSS `ellipse <宽轴%> <高轴%> at Cx Cy`。
 * Figma 两轴 handle 与 CSS「水平半径、垂直半径」顺序需对调，否则与 Dev Mode 数值对调。
 */
function buildRadialGradientCss(fill, stops) {
    const h = fill.gradientHandlePositions;
    if (!Array.isArray(h) || h.length < 3) {
        return `radial-gradient(${stops})`;
    }
    const [p0, p1, p2] = h;
    const x0 = p0?.x ?? 0;
    const y0 = p0?.y ?? 0;
    const x1 = p1?.x ?? 0;
    const y1 = p1?.y ?? 0;
    const x2 = p2?.x ?? 0;
    const y2 = p2?.y ?? 0;
    const cx = x0 * 100;
    const cy = y0 * 100;
    const axisLen1 = Math.hypot(x1 - x0, y1 - y0) * 100;
    const axisLen2 = Math.hypot(x2 - x0, y2 - y0) * 100;
    const fmt = (n) => {
        const s = n.toFixed(2).replace(/\.?0+$/, '');
        return s === '' ? '0' : s;
    };
    // CSS：ellipse 第一个 % 为水平向半径，第二个为垂直向；与 hypot(p1)、hypot(p2) 对调以对齐 Figma
    return `radial-gradient(${fmt(axisLen2)}% ${fmt(axisLen1)}% at ${fmt(cx)}% ${fmt(cy)}%, ${stops})`;
}
/**
 * 构建渐变值
 */
function buildGradientValue(fill) {
    if (!fill || !Array.isArray(fill.gradientStops) || fill.gradientStops.length === 0) {
        return undefined;
    }
    const paintOp = fill.opacity;
    const stops = fill.gradientStops
        .map((stop) => {
        const pos = typeof stop.position === 'number' ? formatGradientStopPercent(stop.position) : '';
        const c = multiplyStopAlpha(stop.color, paintOp);
        const colorStr = rgbaStringGradientStop(c);
        return pos ? `${colorStr} ${pos}` : colorStr;
    })
        .join(', ');
    let gradientType = 'linear-gradient';
    let angle = 180;
    if (fill.type === 'GRADIENT_LINEAR' && Array.isArray(fill.gradientHandlePositions) && fill.gradientHandlePositions.length >= 2) {
        const [start, end] = fill.gradientHandlePositions;
        const dx = (end.x ?? 0) - (start.x ?? 0);
        const dy = (end.y ?? 0) - (start.y ?? 0);
        const rad = Math.atan2(dy, dx);
        // Figma 向量 (dx,dy)（y 向下）→ CSS 渐变角：0° 向上、顺时针；用 90°+atan2 与 Dev Mode 一致（旧式 90°-atan2 竖直向下会错成 0°）
        angle = 90 + (rad * 180) / Math.PI;
        if (angle < 0)
            angle += 360;
        if (angle >= 360)
            angle -= 360;
    }
    else if (fill.type === 'GRADIENT_RADIAL') {
        return buildRadialGradientCss(fill, stops);
    }
    else if (fill.type === 'GRADIENT_DIAMOND' || fill.type === 'GRADIENT_ANGULAR') {
        gradientType = 'conic-gradient';
    }
    const fmtDeg = (deg) => {
        const s = deg.toFixed(2).replace(/\.?0+$/, '');
        return s === '' ? '0' : s;
    };
    return gradientType === 'linear-gradient'
        ? `${gradientType}(${fmtDeg(angle)}deg, ${stops})`
        : `${gradientType}(${stops})`;
}
/**
 * 提取填充颜色（支持多层渐变 + 实色底叠放，与 Figma / CSS `background` 层序一致）
 */
function extractFillColor(node) {
    const fillCandidates = pickFillArray(node);
    const layers = [];
    for (const fill of fillCandidates) {
        if (!fill || fill.visible === false)
            continue;
        if (fill.type === 'IMAGE' || fill.type === 'VIDEO' || fill.type === 'PATTERN')
            continue;
        if (Array.isArray(fill.gradientStops) && fill.gradientStops.length > 0) {
            const value = buildGradientValue(fill);
            if (value)
                layers.push(value);
        }
        else if (fill.type === 'SOLID' && fill.color) {
            const s = solidPaintToCss(fill);
            if (s)
                layers.push(s);
        }
    }
    if (layers.length > 1) {
        const combined = [...layers].reverse().join(', ');
        return { background: combined };
    }
    if (layers.length === 1) {
        const only = layers[0];
        if (node.type === 'TEXT') {
            if (only.includes('gradient')) {
                return { background: only };
            }
            return { color: only };
        }
        return { background: only };
    }
    if (node.backgroundColor) {
        return { background: rgbaString(node.backgroundColor) };
    }
    return undefined;
}
/**
 * 矢量图标常见：仅描边（fills 空）或仅填充。用于 iconfont 的 `style.color`（与 extractFillColor 一致，并补 stroke）。
 */
function extractVectorIconTint(node) {
    const fillOnly = extractFillColor(node);
    let tint = fillOnly?.color ?? fillOnly?.background;
    if (tint && tint.includes('gradient')) {
        tint = undefined;
    }
    if (!tint) {
        const strokeInfo = extractStroke(node);
        if (strokeInfo?.color)
            tint = strokeInfo.color;
    }
    return tint;
}
/**
 * 提取描边
 */
function extractStroke(node) {
    if (!Array.isArray(node?.strokes) || node.strokes.length === 0) {
        return undefined;
    }
    if (typeof node.strokeWeight !== 'number' || node.strokeWeight <= 0) {
        return undefined;
    }
    const stroke = node.strokes.find((item) => item?.type === 'SOLID' && item.visible !== false && item.color);
    if (!stroke) {
        return undefined;
    }
    const style = node.strokeDashes && node.strokeDashes.some((dash) => dash > 0) ? 'dashed' : 'solid';
    return {
        color: rgbaString(stroke.color, stroke.opacity),
        width: Math.round(node.strokeWeight),
        style,
    };
}
function readIndividualStrokeWeights(node) {
    const ind = node?.individualStrokeWeights;
    if (!ind || typeof ind !== 'object')
        return undefined;
    return [
        Math.round(Number(ind.top) || 0),
        Math.round(Number(ind.right) || 0),
        Math.round(Number(ind.bottom) || 0),
        Math.round(Number(ind.left) || 0),
    ];
}
function effectiveStrokeWeight(node) {
    const sides = readIndividualStrokeWeights(node);
    if (sides)
        return Math.max(sides[0], sides[1], sides[2], sides[3]);
    return typeof node.strokeWeight === 'number' ? node.strokeWeight : 0;
}
function resolveStrokeDashStyle(node) {
    return node.strokeDashes && node.strokeDashes.some((dash) => dash > 0) ? 'dashed' : 'solid';
}
/** SOLID 或渐变描边首色标，供对称/不对称边框共用 */
function resolveBorderPaint(node) {
    if (!Array.isArray(node?.strokes) || node.strokes.length === 0) {
        return undefined;
    }
    const w = effectiveStrokeWeight(node);
    if (w <= 0)
        return undefined;
    const dashStyle = resolveStrokeDashStyle(node);
    const strokeSolid = node.strokes.find((item) => item?.type === 'SOLID' && item.visible !== false && item.color);
    if (strokeSolid) {
        return {
            color: rgbaString(strokeSolid.color, strokeSolid.opacity),
            style: dashStyle,
        };
    }
    for (const stroke of node.strokes) {
        if (!stroke || stroke.visible === false)
            continue;
        if (!Array.isArray(stroke.gradientStops) || stroke.gradientStops.length === 0)
            continue;
        const paintOp = stroke.opacity;
        const stops = [...stroke.gradientStops].sort((a, b) => (typeof a.position === 'number' ? a.position : 0) - (typeof b.position === 'number' ? b.position : 0));
        const first = stops[0];
        if (!first?.color)
            continue;
        const c = multiplyStopAlpha(first.color, paintOp);
        return {
            color: rgbaStringGradientStop(c),
            style: dashStyle,
        };
    }
    return undefined;
}
/**
 * 供 border 使用：优先 SOLID；否则渐变描边取首色标近似。支持 Figma `individualStrokeWeights` 单边描边。
 */
function extractStrokeBorderStyle(node) {
    const sides = readIndividualStrokeWeights(node);
    if (sides) {
        const [t, r, b, l] = sides;
        if (t + r + b + l === 0)
            return undefined;
        const paint = resolveBorderPaint(node);
        if (!paint)
            return undefined;
        if (t === r && r === b && b === l) {
            return { color: paint.color, width: t, style: paint.style };
        }
        return { color: paint.color, widthSides: [t, r, b, l], style: paint.style };
    }
    const paint = resolveBorderPaint(node);
    if (!paint)
        return undefined;
    const rounded = Math.round(effectiveStrokeWeight(node));
    if (rounded <= 0)
        return undefined;
    return { color: paint.color, width: rounded, style: paint.style };
}
/**
 * 提取阴影
 */
function extractShadow(node) {
    if (!Array.isArray(node?.effects)) {
        return undefined;
    }
    for (const effect of node.effects) {
        if (effect.type === 'DROP_SHADOW' && effect.visible !== false) {
            const color = effect.color ? rgbaString(effect.color) : 'rgba(0,0,0,0.25)';
            const offsetX = Math.round(effect.offset?.x || 0);
            const offsetY = Math.round(effect.offset?.y || 0);
            const blur = Math.round(effect.radius || 0);
            const spread = Math.round(effect.spread || 0);
            return `${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color}`;
        }
    }
    return undefined;
}
function formatCssPx(value) {
    const rounded = Math.round(value * 100) / 100;
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}px` : `${rounded}px`;
}
/**
 * 提取模糊滤镜
 * - LAYER_BLUR -> filter: blur(...)
 * - BACKGROUND_BLUR -> backdrop-filter: blur(...)
 *
 * REST API 的 BACKGROUND_BLUR.radius 与 CSS 不对等：Figma 工程说明需 **÷2** 才与 Dev Mode / `backdrop-filter: blur()` 一致。
 */
function extractBlurFilters(node) {
    if (!Array.isArray(node?.effects)) {
        return undefined;
    }
    const layerBlur = [];
    const backgroundBlur = [];
    for (const effect of node.effects) {
        if (!effect || effect.visible === false)
            continue;
        if (typeof effect.radius !== 'number' || effect.radius <= 0)
            continue;
        if (effect.type === 'LAYER_BLUR') {
            layerBlur.push(`blur(${formatCssPx(effect.radius)})`);
            continue;
        }
        if (effect.type === 'BACKGROUND_BLUR') {
            backgroundBlur.push(`blur(${formatCssPx(effect.radius / 2)})`);
        }
    }
    const result = {};
    if (layerBlur.length > 0) {
        result.filter = layerBlur.join(' ');
    }
    if (backgroundBlur.length > 0) {
        result.backdropFilter = backgroundBlur.join(' ');
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
/**
 * 提取圆角
 */
function extractCornerRadius(node) {
    if (node.rectangleCornerRadii) {
        const corners = node.rectangleCornerRadii;
        const values = [
            Math.round(corners?.topLeftCornerRadius ?? node.cornerRadius ?? 0),
            Math.round(corners?.topRightCornerRadius ?? node.cornerRadius ?? 0),
            Math.round(corners?.bottomRightCornerRadius ?? node.cornerRadius ?? 0),
            Math.round(corners?.bottomLeftCornerRadius ?? node.cornerRadius ?? 0),
        ];
        const allEqual = values.every((v) => v === values[0]);
        return allEqual ? values[0] : values;
    }
    if (typeof node.cornerRadius === 'number') {
        return Math.round(node.cornerRadius);
    }
    return undefined;
}
/**
 * 提取内边距
 */
function extractPadding(node) {
    return [
        Math.round(node.paddingTop ?? 0),
        Math.round(node.paddingRight ?? 0),
        Math.round(node.paddingBottom ?? 0),
        Math.round(node.paddingLeft ?? 0),
    ];
}
/**
 * AST 节点稳定标识：Figma 图层 `id` 与 `name` 拼接，便于与设计稿对照。
 */
function makeFigmaAstId(node) {
    const id = typeof node?.id === 'string' ? node.id.trim() : '';
    const name = typeof node?.name === 'string' ? node.name.trim() : '';
    if (id && name)
        return `${id}-${name}`;
    if (id)
        return `${id}-unnamed`;
    if (name)
        return `unknown-${name}`;
    return 'unknown';
}
/**
 * 映射对齐值
 */
function mapAlignValue(value) {
    if (!value)
        return undefined;
    switch (value) {
        case 'MIN':
            return 'flex-start';
        case 'MAX':
            return 'flex-end';
        case 'CENTER':
            return 'center';
        case 'SPACE_BETWEEN':
            return 'space-between';
        case 'BASELINE':
            return 'baseline';
        case 'STRETCH':
            return 'stretch';
        default:
            return undefined;
    }
}
/**
 * 映射自身对齐值
 */
function mapSelfAlignValue(value) {
    if (!value || value === 'INHERIT')
        return undefined;
    switch (value) {
        case 'MIN':
            return 'flex-start';
        case 'MAX':
            return 'flex-end';
        case 'CENTER':
            return 'center';
        case 'STRETCH':
            return 'stretch';
        default:
            return value.toLowerCase();
    }
}
/**
 * 标准化尺寸值
 */
function normalizeSizingValue(value) {
    return typeof value === 'string' ? value.toLowerCase() : undefined;
}
/**
 * 映射文本对齐
 */
function mapTextAlign(value) {
    if (!value)
        return undefined;
    switch (value) {
        case 'LEFT':
            return 'left';
        case 'CENTER':
            return 'center';
        case 'RIGHT':
            return 'right';
        case 'JUSTIFIED':
            return 'justify';
        default:
            return value.toLowerCase();
    }
}
/**
 * 映射文本装饰
 */
function mapTextDecoration(value) {
    if (!value || value === 'NONE')
        return undefined;
    switch (value) {
        case 'UNDERLINE':
            return 'underline';
        case 'STRIKETHROUGH':
            return 'line-through';
        default:
            return value.toLowerCase();
    }
}
/**
 * 映射文本大小写
 */
function mapTextCase(value) {
    if (!value || value === 'ORIGINAL')
        return undefined;
    switch (value) {
        case 'UPPER':
            return 'uppercase';
        case 'LOWER':
            return 'lowercase';
        case 'TITLE':
            return 'capitalize';
        case 'SMALL_CAPS':
            return 'small-caps';
        default:
            return value.toLowerCase();
    }
}

/**
 * 样式提取
 */
/**
 * 提取节点样式
 */
function extractNodeStyle(node) {
    const style = {};
    const bbox = node.absoluteBoundingBox;
    if (bbox) {
        const width = Math.round(Math.abs(bbox.width || 0));
        const height = Math.round(Math.abs(bbox.height || 0));
        if (width > MIN_RENDERABLE_SIZE)
            style.width = width;
        if (height > MIN_RENDERABLE_SIZE)
            style.height = height;
        style.x = Math.round(bbox.x || 0);
        style.y = Math.round(bbox.y || 0);
    }
    const padding = extractPadding(node);
    if (padding.some((value) => value !== 0)) {
        style.padding = padding;
    }
    const radius = extractCornerRadius(node);
    if (radius !== undefined && radius !== 0) {
        style.borderRadius = radius;
    }
    const stroke = extractStrokeBorderStyle(node);
    if (stroke?.color) {
        style.borderColor = stroke.color;
        if (stroke.widthSides) {
            style.borderWidthSides = stroke.widthSides;
        }
        else if (stroke.width !== undefined) {
            style.borderWidth = stroke.width;
        }
        if (stroke.style === 'dashed') {
            style.borderStyle = 'dashed';
        }
    }
    const fill = extractFillColor(node);
    if (fill?.background && fill.background !== 'rgba(0,0,0,0)') {
        style.background = fill.background;
    }
    if (fill?.color) {
        style.color = fill.color;
    }
    const shadow = extractShadow(node);
    if (shadow) {
        style.shadow = shadow;
    }
    const blurFilters = extractBlurFilters(node);
    if (blurFilters?.filter) {
        style.filter = blurFilters.filter;
    }
    if (blurFilters?.backdropFilter) {
        style.backdropFilter = blurFilters.backdropFilter;
    }
    if (node.opacity !== undefined && node.opacity < 1) {
        style.opacity = Number(node.opacity.toFixed(3));
    }
    if (node.clipsContent === true) {
        style.overflow = 'hidden';
    }
    // constraints 信息对于 LLM 生成代码来说通常是噪音，
    // 因为我们已经有了具体的 layout (flex) 或者计算好的 absolute position。
    // if (node.constraints && (node.constraints.horizontal || node.constraints.vertical)) {
    //   style.constraints = {
    //     horizontal: node.constraints.horizontal,
    //     vertical: node.constraints.vertical,
    //   }
    // }
    if (node.type === 'TEXT' && node.style) {
        if (node.style.fontSize)
            style.fontSize = Math.round(node.style.fontSize);
        if (node.style.fontWeight)
            style.fontWeight = Math.round(node.style.fontWeight);
        if (node.style.lineHeightPx)
            style.lineHeight = Math.round(node.style.lineHeightPx);
        // lineHeightPercent 只有在没有 lineHeightPx 时或者是百分比布局才比较重要，
        // 但通常 lineHeightPx 更直接。这里为了减少 LLM 噪音，如果已有 lineHeight，不再输出 percent。
        if (!style.lineHeight && typeof node.style.lineHeightPercentFontSize === 'number') {
            style.lineHeightPercent = Number(node.style.lineHeightPercentFontSize.toFixed(2));
        }
        if (typeof node.style.letterSpacing === 'number' && node.style.letterSpacing !== 0) {
            style.letterSpacing = Number(node.style.letterSpacing.toFixed(2));
        }
        if (node.style.fontFamily)
            style.fontFamily = node.style.fontFamily;
        const textAlign = mapTextAlign(node.style.textAlignHorizontal);
        if (textAlign)
            style.textAlign = textAlign;
        const decoration = mapTextDecoration(node.style.textDecoration);
        if (decoration)
            style.textDecoration = decoration;
        const textCase = mapTextCase(node.style.textCase);
        if (textCase)
            style.textCase = textCase;
    }
    return Object.keys(style).length ? style : undefined;
}
/** Figma Grid 子项单元格内对齐 → CSS `justify-self` / `align-self` */
function mapGridChildCellAlign(value) {
    if (!value || String(value).toUpperCase() === 'AUTO')
        return undefined;
    switch (String(value).toUpperCase()) {
        case 'MIN':
            return 'start';
        case 'MAX':
            return 'end';
        case 'CENTER':
            return 'center';
        case 'STRETCH':
            return 'stretch';
        default:
            return undefined;
    }
}
function extractGridPlacement(node) {
    const hasPlacement = typeof node.gridColumnAnchorIndex === 'number' ||
        typeof node.gridRowAnchorIndex === 'number' ||
        (typeof node.gridColumnSpan === 'number' && node.gridColumnSpan > 0) ||
        (typeof node.gridRowSpan === 'number' && node.gridRowSpan > 0);
    if (!hasPlacement)
        return undefined;
    const colAnch = typeof node.gridColumnAnchorIndex === 'number' ? node.gridColumnAnchorIndex : 0;
    const rowAnch = typeof node.gridRowAnchorIndex === 'number' ? node.gridRowAnchorIndex : 0;
    const colSpan = typeof node.gridColumnSpan === 'number' && node.gridColumnSpan > 0 ? Math.round(node.gridColumnSpan) : 1;
    const rowSpan = typeof node.gridRowSpan === 'number' && node.gridRowSpan > 0 ? Math.round(node.gridRowSpan) : 1;
    const placement = {
        columnStart: colAnch + 1,
        columnSpan: colSpan,
        rowStart: rowAnch + 1,
        rowSpan,
    };
    const justifySelf = mapGridChildCellAlign(node.gridChildHorizontalAlign);
    const alignSelf = mapGridChildCellAlign(node.gridChildVerticalAlign);
    if (justifySelf)
        placement.justifySelf = justifySelf;
    if (alignSelf)
        placement.alignSelf = alignSelf;
    return placement;
}
/**
 * 提取布局信息
 */
function extractLayout(node) {
    const layout = { display: 'block' };
    let hasInfo = false;
    const mode = typeof node.layoutMode === 'string' ? node.layoutMode.toUpperCase() : '';
    if (mode === 'GRID') {
        layout.display = 'inline-grid';
        layout.grid = {};
        if (typeof node.gridColumnsSizing === 'string' && node.gridColumnsSizing.trim()) {
            layout.grid.templateColumns = node.gridColumnsSizing.trim();
        }
        if (typeof node.gridRowsSizing === 'string' && node.gridRowsSizing.trim()) {
            layout.grid.templateRows = node.gridRowsSizing.trim();
        }
        if (typeof node.gridColumnCount === 'number')
            layout.grid.columnCount = node.gridColumnCount;
        if (typeof node.gridRowCount === 'number')
            layout.grid.rowCount = node.gridRowCount;
        if (typeof node.gridColumnGap === 'number') {
            layout.grid.columnGap = Math.round(node.gridColumnGap);
        }
        if (typeof node.gridRowGap === 'number') {
            layout.grid.rowGap = Math.round(node.gridRowGap);
        }
        hasInfo = true;
    }
    else if (mode === 'HORIZONTAL' || mode === 'VERTICAL') {
        layout.display = 'flex';
        layout.direction = mode === 'VERTICAL' ? 'column' : 'row';
        hasInfo = true;
        // Figma REST 在值为默认 MIN 时常省略字段；OpenAPI 规定 primary/counter 轴对齐默认均为 MIN → flex-start
        const counterAxis = typeof node.counterAxisAlignItems === 'string' ? node.counterAxisAlignItems : 'MIN';
        const primaryAxis = typeof node.primaryAxisAlignItems === 'string' ? node.primaryAxisAlignItems : 'MIN';
        const align = mapAlignValue(counterAxis);
        if (align) {
            layout.align = align;
            layout.alignItems = align;
        }
        const justify = mapAlignValue(primaryAxis);
        if (justify) {
            layout.justify = justify;
            layout.justifyContent = justify;
        }
        // 主轴为「沿轴分布」时，间距由 justify-content（space-between 等）承担；Figma 仍可能带 itemSpacing，
        // 若再映射成 gap，易与主轴对齐语义打架，且生码常只实现 gap 导致跑版。
        const primaryIsSpaceDistribution = primaryAxis === 'SPACE_BETWEEN' ||
            primaryAxis === 'SPACE_AROUND' ||
            primaryAxis === 'SPACE_EVENLY';
        // 含 0 / 负数：Figma 负 itemSpacing 表示子项重叠，CSS gap 不支持负值，生码时需另用 margin 等表达
        if (typeof node.itemSpacing === 'number' && !primaryIsSpaceDistribution) {
            layout.gap = Math.round(node.itemSpacing);
        }
        if (node.layoutWrap) {
            layout.wrap = node.layoutWrap === 'WRAP' ? 'wrap' : 'nowrap';
        }
    }
    const gridPlacement = extractGridPlacement(node);
    if (gridPlacement) {
        layout.gridPlacement = gridPlacement;
        hasInfo = true;
    }
    // Figma layoutAlign=STRETCH → stretch：若写进生码常为 align-self:stretch，会覆盖父级 align-items（如居中）。
    // 稿面「拉满交叉轴」多数可由父级 align-items:stretch（flex 默认）或子项宽高表达，故不输出 stretch。
    // Grid 子项格内对齐用 gridPlacement，不再重复写外层 alignSelf。
    const alignSelfFlex = mapSelfAlignValue(node.layoutAlign);
    if (alignSelfFlex && alignSelfFlex !== 'stretch' && !gridPlacement) {
        layout.alignSelf = alignSelfFlex;
        hasInfo = true;
    }
    if (typeof node.layoutGrow === 'number' && node.layoutGrow !== 0) {
        layout.grow = Number(node.layoutGrow.toFixed(3));
        hasInfo = true;
    }
    if (typeof node.layoutShrink === 'number' && node.layoutShrink !== 1) {
        layout.shrink = Number(node.layoutShrink.toFixed(3));
        hasInfo = true;
    }
    const horizontal = normalizeSizingValue(node.layoutSizingHorizontal);
    const vertical = normalizeSizingValue(node.layoutSizingVertical);
    if (horizontal || vertical) {
        layout.sizing = {};
        if (horizontal)
            layout.sizing.horizontal = horizontal;
        if (vertical)
            layout.sizing.vertical = vertical;
        hasInfo = true;
    }
    return hasInfo ? layout : undefined;
}
function mergeFigmaTextBaseWithOverride(base, overrideIndex, table) {
    const entry = typeof overrideIndex === 'number' &&
        overrideIndex > 0 &&
        table &&
        typeof table === 'object' &&
        table[String(overrideIndex)]
        ? table[String(overrideIndex)]
        : undefined;
    if (!entry || typeof entry !== 'object')
        return { ...base };
    return { ...base, ...entry };
}
/** 单段字符样式 → Clean（不含 textAlign，段落级留在父节点 style） */
function mergedFigmaStyleToRunTypography(merged, fillColor) {
    const s = {};
    if (typeof merged.fontSize === 'number')
        s.fontSize = Math.round(merged.fontSize);
    if (merged.fontWeight !== undefined && merged.fontWeight !== null) {
        s.fontWeight = Math.round(Number(merged.fontWeight));
    }
    if (typeof merged.lineHeightPx === 'number')
        s.lineHeight = Math.round(merged.lineHeightPx);
    if (!s.lineHeight && typeof merged.lineHeightPercentFontSize === 'number') {
        s.lineHeightPercent = Number(merged.lineHeightPercentFontSize.toFixed(2));
    }
    if (typeof merged.letterSpacing === 'number' && merged.letterSpacing !== 0) {
        s.letterSpacing = Number(merged.letterSpacing.toFixed(2));
    }
    if (typeof merged.fontFamily === 'string' && merged.fontFamily)
        s.fontFamily = merged.fontFamily;
    if (fillColor)
        s.color = fillColor;
    const decoration = mapTextDecoration(merged.textDecoration);
    if (decoration)
        s.textDecoration = decoration;
    const textCase = mapTextCase(merged.textCase);
    if (textCase)
        s.textCase = textCase;
    return s;
}
function styleSignature(s) {
    const keys = Object.keys(s).sort();
    const o = {};
    for (const k of keys)
        o[String(k)] = s[k];
    return JSON.stringify(o);
}
/**
 * Figma TEXT 单行内混用 characterStyleOverrides / styleOverrideTable 时，拆成多段样式。
 * 无混排或无法解析时返回 undefined。
 */
function extractMixedTextRuns(node) {
    if (node?.type !== 'TEXT' || typeof node.characters !== 'string')
        return undefined;
    const chars = node.characters;
    if (chars.length === 0)
        return undefined;
    const ov = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
    const table = node.styleOverrideTable;
    const base = node.style && typeof node.style === 'object' ? node.style : {};
    const fillColor = extractFillColor(node)?.color;
    const getOverrideIndex = (i) => {
        if (i >= ov.length)
            return 0;
        const v = ov[i];
        return typeof v === 'number' && v >= 0 ? v : 0;
    };
    const runs = [];
    let i = 0;
    while (i < chars.length) {
        const idx = getOverrideIndex(i);
        let j = i + 1;
        while (j < chars.length && getOverrideIndex(j) === idx)
            j++;
        const slice = chars.slice(i, j);
        const merged = mergeFigmaTextBaseWithOverride(base, idx, table);
        runs.push({ text: slice, style: mergedFigmaStyleToRunTypography(merged, fillColor) });
        i = j;
    }
    if (runs.length <= 1)
        return undefined;
    const sig0 = styleSignature(runs[0].style);
    if (runs.every((r) => styleSignature(r.style) === sig0))
        return undefined;
    return runs;
}
/** 有 textRuns 时从父节点去掉已下沉到各段的字体相关字段，避免与 textRuns 矛盾 */
function stripTextTypographyForMixedRuns(style) {
    if (!style)
        return;
    delete style.fontSize;
    delete style.fontWeight;
    delete style.lineHeight;
    delete style.lineHeightPercent;
    delete style.letterSpacing;
    delete style.fontFamily;
    delete style.textDecoration;
    delete style.textCase;
    delete style.color;
}

/**
 * processFigmaData / createCleanAst 单次运行期的依赖提示。
 * 各解析路径调用 mark*，由 processor/index 汇总为 requiredMark（多段用空行拼接）。
 */
/**
 * 与 @xybot/iconfont 的 IconFont 行为一致：type 会规范为带 icon- 的类名，并与基础类 iconfont 组合。
 * 样式应在应用入口全局引入一次（见 ICONFONT_ENTRY_CSS_IMPORT）。
 */
/** 入口文件只执行一次，例如 main.tsx / app 根 layout */
const ICONFONT_ENTRY_CSS_IMPORT = `import '@xybot/iconfont/index.css'`;
const ICONFONT_USAGE_DEMO = `import { IconFont } from '@xybot/iconfont'

<IconFont type={fontClass} style={{ fontSize: node.style?.fontSize, color: node.style?.color }} />`;
const ADDENDUM = {
    iconfont: [
        '【系统约束】AST 中存在 type 为 iconfont 的节点。请安装依赖 @xybot/iconfont；在应用入口文件（如 main.tsx、根 layout）全局只引入一次样式：import \'@xybot/iconfont/index.css\'。业务组件内使用 IconFont 渲染，把节点上的 fontClass 传给 IconFont 的 type；禁止用空标签或手写 class 冒充图标。',
        '用法要点：1）组件里 import { IconFont } from \'@xybot/iconfont\'，不要在每个组件里重复 import CSS，样式只在入口引一次。2）fontClass → IconFont 的 type；若不以 icon 开头，IconFont 会自动处理成带 icon- 的类名。3）AST 的 style 用 fontSize（字图标字号）与 color（填充色）映射到 IconFont 的 style，勿用 width/height 当图标尺寸。',
        '入口样式（全局一次）：',
        ICONFONT_ENTRY_CSS_IMPORT,
        '组件示例：',
        ICONFONT_USAGE_DEMO,
    ].join('\n\n'),
    'xybot-ui': '【系统约束】AST 中存在 @xybot/ui 组件（如 UIButton）。请安装依赖 @xybot/ui，按组件库导出与文档使用 props，勿用手写 DOM 占位。',
};
/** 多段提示时的输出顺序（可按产品习惯调整） */
const ORDER = ['xybot-ui', 'iconfont'];
const active = new Set();
function resetProcessedGenerationState() {
    active.clear();
}
function markProcessedDependency(key) {
    active.add(key);
}
const markHasIconfont = () => markProcessedDependency('iconfont');
/** resolveLibraryComponentType 命中 components.json 映射时调用 */
const markNeedsXybotUi = () => markProcessedDependency('xybot-ui');
/** 供 processFigmaData 在返回 processed 时写入 requiredMark */
function getRequiredMarkForProcessed() {
    return ORDER.filter((k) => active.has(k))
        .map((k) => ADDENDUM[k])
        .join('\n\n');
}

/**
 * 自动布局兼容处理
 * 针对自动布局的 Figma JSON，特殊处理背景图和内容的分离
 */
/**
 * 判断节点是否使用自动布局
 */
function isAutoLayoutNode(node) {
    if (!node || typeof node !== 'object')
        return false;
    const mode = node.layoutMode;
    return mode === 'HORIZONTAL' || mode === 'VERTICAL';
}
/**
 * 判断节点是否有图片填充作为背景
 */
function hasImageFillBackground(node) {
    if (!node || !Array.isArray(node.fills))
        return false;
    return node.fills.some((fill) => fill &&
        fill.type === 'IMAGE' &&
        fill.visible !== false &&
        fill.imageRef);
}
/**
 * 为自动布局节点创建 AST
 * 特殊处理：如果节点有图片填充且有子节点，将图片作为背景，子节点正常处理
 */
function createAutoLayoutAstNode(node, asset, nodeType, style, children) {
    const astNode = {
        type: nodeType,
        id: makeFigmaAstId(node),
    };
    if (style) {
        astNode.style = style;
    }
    // 自动布局特殊处理：如果节点有图片填充且有子节点，将图片作为背景
    if (asset && asset.source === 'fill' && hasImageFillBackground(node) && children && children.length > 0) {
        if (!astNode.style) {
            astNode.style = {};
        }
        // 标记为背景图，但保留子节点
        astNode.style.isBackground = true;
        astNode.asset = {
            index: asset.index,
            path: asset.path,
            mode: asset.mode,
            transform: asset.transform,
        };
        // 保留子节点
        astNode.children = children;
    }
    else {
        // 正常处理 asset
        if (asset) {
            astNode.asset = {
                index: asset.index,
                path: asset.path,
                mode: asset.mode,
                transform: asset.transform,
            };
        }
        // 如果有 asset 且不是 fill 类型，或者没有 asset，才处理子节点
        if ((!asset || asset.source !== 'fill') && children && children.length > 0) {
            astNode.children = children;
        }
    }
    return astNode;
}

// ========================
// OSS 上传相关方法
// ========================
/**
 * 生成随机 hash 字符串
 */
function generateHash() {
    // 使用 crypto API 生成随机字节并转换为 hex 字符串
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
/**
 * 上传文件到 OSS（最小上传单元，无超时重试机制）
 * @param file 要上传的文件（Blob 或 File）
 * @param config 上传配置（可选）
 * @returns 上传后的访问 URL
 */
async function uploadToOSS(file, config) {
    const maxSize = config?.maxSize || 1024 * 1024 * 1024; // 默认 1GB
    const uploadUrl = config?.uploadUrl || 'https://staging-logs.yingdao.com/report-api/upload/file';
    try {
        // 确保是 File 对象
        const originalFile = file instanceof File ? file : new File([file], 'upload', { type: file.type });
        // 检查文件大小
        if (originalFile.size > maxSize) {
            const sizeInMB = (originalFile.size / 1024 / 1024).toFixed(2);
            const maxSizeInMB = (maxSize / 1024 / 1024).toFixed(2);
            throw new Error(`文件大小 ${sizeInMB}MB 超过限制 ${maxSizeInMB}MB`);
        }
        // 提取文件名和扩展名
        const originalName = originalFile.name;
        let baseName = originalName;
        let extension = '';
        if (originalName.includes('.')) {
            const lastDotIndex = originalName.lastIndexOf('.');
            baseName = originalName.substring(0, lastDotIndex);
            extension = originalName.substring(lastDotIndex);
        }
        else if (originalFile.type) {
            // 如果没有扩展名，尝试从 MIME 类型获取
            const mimeExtension = originalFile.type.split('/')[1];
            if (mimeExtension) {
                extension = `.${mimeExtension}`;
            }
        }
        // 生成随机 hash 并拼接到原始文件名
        const hash = generateHash();
        const hashFileName = `${baseName}_${hash}${extension}`;
        // 创建使用 hash 文件名的 File 对象
        const fileObj = new File([originalFile], hashFileName, { type: originalFile.type });
        // 使用 FormData 上传文件
        const formData = new FormData();
        formData.append('filename', hashFileName);
        formData.append('file', fileObj);
        // 上传文件
        const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Upload failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
        }
        const result = (await response.json());
        // 获取返回的 URL（支持多种响应格式）
        const fileUrl = result.data?.readUrl;
        if (!fileUrl) {
            throw new Error('上传成功但未获取到文件 URL');
        }
        return fileUrl;
    }
    catch (error) {
        console.error('[OSS] Upload failed', { fileName: file instanceof File ? file.name : 'unknown', error });
        throw error;
    }
}

/**
 * 从 Figma API 解析图片 URL；可选二次上传到 OSS
 */
function isNodeRuntime$1() {
    return typeof process !== 'undefined' && Boolean(process?.versions?.node);
}
/**
 * 解析所有图片 URL（默认直接使用 Figma 返回的链接；可选下载并上传到 OSS）
 *
 * @param skipOSSUpload - 为 true 时不 fetch 文件体、不上传，paths 中为 Figma 临时 URL
 * @returns 图片 URL 映射 { imageRef: url }
 */
async function downloadFigmaImages(token, fileKey, imageRefs, isIcon = false, nodeNames, ossConfig, skipOSSUpload = true) {
    if (Object.keys(imageRefs).length === 0)
        return {};
    const format = isIcon ? 'svg' : 'png';
    const isRenderRef = (ref) => ref.startsWith('group_') || ref.startsWith('instance_') || ref.startsWith('icon_');
    const paths = {};
    let index = 0;
    const uploadedSvgs = new Map(); // 去重后的 svg 内容缓存
    // ========================
    // 1) 处理 fill imageRef（背景/填充图片）：使用 Get image fills API
    // ========================
    const fillRefs = isIcon
        ? []
        : Object.keys(imageRefs).filter((ref) => !isRenderRef(ref));
    if (fillRefs.length > 0) {
        const fillUrls = await getFigmaImageFillUrls(token, fileKey, fillRefs);
        if (skipOSSUpload) {
            console.log(`绑定 ${fillRefs.length} 个 image fill 为 Figma URL（未二次上传，PNG 来源：image fills）…`);
            for (const imageRef of fillRefs) {
                const figmaUrl = fillUrls[imageRef];
                if (!figmaUrl) {
                    console.warn(`⚠️  imageRef ${imageRef} 的图片 URL 未找到（image fills）`);
                    continue;
                }
                paths[imageRef] = figmaUrl;
                index++;
            }
        }
        else {
            console.log(`正在上传 ${fillRefs.length} 张图片到 OSS（PNG格式，来源：image fills）...`);
            for (const imageRef of fillRefs) {
                const figmaUrl = fillUrls[imageRef];
                if (!figmaUrl) {
                    console.warn(`⚠️  imageRef ${imageRef} 的图片 URL 未找到（image fills）`);
                    continue;
                }
                const fileName = `img-${index}.${format}`;
                try {
                    const res = await fetch(figmaUrl);
                    if (!res.ok)
                        throw new Error(`从 Figma 下载失败: ${res.status}`);
                    const arrayBuffer = await res.arrayBuffer();
                    const blob = new Blob([arrayBuffer], { type: 'image/png' });
                    const file = new File([blob], fileName, { type: blob.type });
                    const ossUrl = await uploadToOSS(file, ossConfig || {});
                    paths[imageRef] = ossUrl;
                    if (isNodeRuntime$1()) {
                        try {
                            const dynamicImport = new Function('m', 'return import(m)');
                            const fsMod = await dynamicImport('fs/promises');
                            const pathMod = await dynamicImport('path');
                            const mkdir = fsMod.mkdir;
                            const writeFile = fsMod.writeFile;
                            const join = pathMod.join;
                            const pagesDir = 'src/pages';
                            await mkdir(pagesDir, { recursive: true });
                            const localPath = join(pagesDir, fileName);
                            await writeFile(localPath, new Uint8Array(arrayBuffer));
                        }
                        catch (err) {
                            console.warn(`保存图片到本地失败 (${fileName}):`, err);
                        }
                    }
                    index++;
                }
                catch (error) {
                    console.error(`处理图片失败 (imageRef=${imageRef}):`, error instanceof Error ? error.message : String(error));
                }
            }
        }
    }
    // ========================
    // 2) 处理 node render（group_/instance_/icon_）：使用 Images API（渲染节点）
    // ========================
    const renderEntries = Object.entries(imageRefs).filter(([ref]) => isIcon || isRenderRef(ref));
    if (renderEntries.length > 0) {
        // 去重：确保同一个 nodeId 只下载一次
        const uniqueNodeIds = new Set();
        const nodeIdToRefs = new Map(); // nodeId -> imageRefs[]
        for (const [ref, nodeId] of renderEntries) {
            if (!uniqueNodeIds.has(nodeId)) {
                uniqueNodeIds.add(nodeId);
                nodeIdToRefs.set(nodeId, []);
            }
            nodeIdToRefs.get(nodeId).push(ref);
        }
        console.log(skipOSSUpload
            ? `绑定 ${uniqueNodeIds.size} 个节点为 Figma URL（未二次上传，${format.toUpperCase()}，来源：node render）…`
            : `正在上传 ${uniqueNodeIds.size} ${isIcon ? '个图标' : '张图片'}到 OSS（${format.toUpperCase()}格式，来源：node render）...`);
        const imageUrls = await getFigmaImageUrls(token, fileKey, Array.from(uniqueNodeIds), format, {
            // PNG：use_absolute_bounds=true（默认）保留 Frame 完整尺寸与画板内留白；SVG icon：默认 false
            useAbsoluteBounds: format === 'png',
        });
        for (const nodeId of uniqueNodeIds) {
            const figmaUrl = imageUrls[nodeId];
            if (!figmaUrl) {
                console.warn(`⚠️  节点 ${nodeId} 的图片 URL 未找到`);
                continue;
            }
            if (skipOSSUpload) {
                const refs = nodeIdToRefs.get(nodeId) || [];
                for (const ref of refs) {
                    paths[ref] = figmaUrl;
                }
                index++;
                continue;
            }
            const fileName = isIcon ? `icon-${index}.${format}` : `img-${index}.${format}`;
            try {
                console.log(`  [image-downloader] 从 Figma 下载 ${nodeId} …`);
                const res = await fetch(figmaUrl);
                if (!res.ok)
                    throw new Error(`从 Figma 下载失败: ${res.status}`);
                // 对于 SVG，需要先获取文本内容用于去重
                let rawContent = '';
                let arrayBuffer;
                if (format === 'svg') {
                    rawContent = await res.text();
                    arrayBuffer = new TextEncoder().encode(rawContent).buffer;
                }
                else {
                    arrayBuffer = await res.arrayBuffer();
                }
                const blob = new Blob([arrayBuffer], { type: format === 'svg' ? 'image/svg+xml' : 'image/png' });
                const file = new File([blob], fileName, { type: blob.type });
                let shouldSkip = false;
                let existingUrl = '';
                if (isIcon && format === 'svg') {
                    const currentPathData = extractSvgPathData(rawContent);
                    const currentName = nodeNames?.[nodeId];
                    for (const [, info] of uploadedSvgs.entries()) {
                        const existingPathData = extractSvgPathData(info.content);
                        if (!areSvgPathsSimilar(existingPathData, currentPathData))
                            continue;
                        if (currentName && info.name && currentName !== info.name)
                            continue;
                        shouldSkip = true;
                        existingUrl = info.url;
                        break;
                    }
                }
                if (shouldSkip && existingUrl) {
                    const refs = nodeIdToRefs.get(nodeId) || [];
                    for (const ref of refs) {
                        paths[ref] = existingUrl;
                    }
                    continue;
                }
                console.log(`  [image-downloader] 上传到 OSS ${fileName} …`);
                const ossUrl = await uploadToOSS(file, ossConfig || {});
                console.log(`  [image-downloader] 上传到 OSS ${fileName} 成功: ${ossUrl}`);
                // 调试：保存图片到本地 src/pages
                if (isNodeRuntime$1()) {
                    try {
                        const dynamicImport = new Function('m', 'return import(m)');
                        const fsMod = await dynamicImport('fs/promises');
                        const pathMod = await dynamicImport('path');
                        const mkdir = fsMod.mkdir;
                        const writeFile = fsMod.writeFile;
                        const join = pathMod.join;
                        const pagesDir = 'src/pages';
                        await mkdir(pagesDir, { recursive: true });
                        const localPath = join(pagesDir, fileName);
                        await writeFile(localPath, new Uint8Array(arrayBuffer));
                    }
                    catch (err) {
                        console.warn(`保存图片到本地失败 (${fileName}):`, err);
                    }
                }
                const refs = nodeIdToRefs.get(nodeId) || [];
                for (const ref of refs) {
                    paths[ref] = ossUrl;
                }
                if (isIcon && format === 'svg') {
                    uploadedSvgs.set(nodeId, { url: ossUrl, content: rawContent, name: nodeNames?.[nodeId] });
                }
                index++;
            }
            catch (error) {
                console.error(`处理图片失败 (${nodeId}):`, error instanceof Error ? error.message : String(error));
            }
        }
    }
    console.log(skipOSSUpload
        ? `✓ 已解析 ${index} ${isIcon ? '个图标' : '张图片'}的 Figma URL`
        : `✓ 成功上传 ${index} ${isIcon ? '个图标' : '张图片'}到 OSS`);
    return paths;
}

/**
 * 图片提取
 */
/**
 * 图层名命中 img-/wholeImage 时，允许整节点走 Figma Images API 渲染为位图的类型。
 * 原先仅含 Frame/Group 等容器，不含 RECTANGLE/ELLIPSE 等单层形状，导致如 `img-301` 矩形无法切图。
 */
const IMG_NAME_WHOLE_RENDER_TYPES = new Set([
    'GROUP',
    'FRAME',
    'INSTANCE',
    'COMPONENT',
    'RECTANGLE',
    'ELLIPSE',
    'LINE',
    'POLYGON',
    'STAR',
    'VECTOR',
]);
/**
 * 与 extractImageRefs 中「整图切片」命名规则一致（img-/logo-/wholeImage 配置）。
 */
function matchesWholeRasterSliceName(nodeName, wholeImageLayerNames) {
    const hintList = (wholeImageLayerNames || [])
        .map((h) => String(h).trim().toLowerCase())
        .filter(Boolean);
    const layerNameLower = (nodeName || '').toLowerCase();
    const hasWholeImageLayerNameHint = hintList.length > 0 && hintList.some((hint) => layerNameLower.includes(hint));
    const hasImgNameMarker = layerNameLower.startsWith('img_') ||
        layerNameLower.startsWith('img-') ||
        layerNameLower.endsWith('-img') ||
        layerNameLower.endsWith('_img');
    const hasLogoNameMarker = layerNameLower.startsWith('logo-');
    const extraNameMarkers = ['logo', 'icon', 'img', 'image'];
    const hasExtraNameMarker = extraNameMarkers.some((marker) => layerNameLower.includes(marker));
    return hasWholeImageLayerNameHint || hasImgNameMarker || hasLogoNameMarker || hasExtraNameMarker;
}
/**
 * 是否应按「整节点位图」处理（与 extractImageRefs 的 group_${id} 一致）。
 */
function isWholeRasterSliceNode(node, wholeImageLayerNames) {
    if (!node?.id || !node?.type)
        return false;
    if (!IMG_NAME_WHOLE_RENDER_TYPES.has(node.type))
        return false;
    return matchesWholeRasterSliceName(node.name, wholeImageLayerNames);
}
function pickInnerVectorIconId(node) {
    if (!node || typeof node !== 'object')
        return undefined;
    // 如果节点本身就是矢量类型，直接返回（但通常此函数是对容器调用的）
    if (VECTOR_NODE_TYPES.has(node.type))
        return node.id;
    // 筛选出对外观有贡献的可见子节点（忽略空文本）
    const children = Array.isArray(node.children) ? node.children : [];
    const visibleChildren = children.filter((c) => {
        if (!c || c.visible === false)
            return false;
        // 忽略空的文本节点（可能是不可见占位符）
        if (c.type === 'TEXT' && (!c.characters || !c.characters.trim()))
            return false;
        return true;
    });
    // 如果只有一个可见子节点，我们可以安全地剥离父容器（如 Frame），直接取子节点
    if (visibleChildren.length === 1) {
        const child = visibleChildren[0];
        // 如果子节点是矢量，直接返回它的 ID
        if (VECTOR_NODE_TYPES.has(child.type)) {
            return child.id;
        }
        // 如果子节点是容器（Group/Frame/Instance），递归尝试剥离
        if (['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT'].includes(child.type)) {
            const inner = pickInnerVectorIconId(child);
            // 只有递归到「单矢量」等可唯一替代目标时才用 inner；若内层是「多子元素组合」且无法继续剥离，
            // 不得退回 child.id，否则会只导出内层 Frame，丢掉外层 icon 容器的描边/背景/圆角等（看起来像「导成了别的图」）。
            if (inner)
                return inner;
            return undefined;
        }
    }
    // 如果有多个可见子节点（例如 Circle + Checkmark），或者没有可见子节点：
    // 我们不能简单地选一个"最大"的，否则会丢失其他部分。
    // 返回 undefined 表示"无法剥离，请使用原始节点（父节点）作为导出目标"。
    return undefined;
}
function findNodeById(root, id) {
    if (!root || typeof root !== 'object')
        return undefined;
    if (root.id === id)
        return root;
    if (Array.isArray(root.children)) {
        for (const c of root.children) {
            const hit = findNodeById(c, id);
            if (hit)
                return hit;
        }
    }
    return undefined;
}
function getNodeBoxSize(node) {
    const bbox = node?.absoluteBoundingBox;
    if (!bbox)
        return {};
    const width = Math.round(Math.abs(bbox.width || 0));
    const height = Math.round(Math.abs(bbox.height || 0));
    if (!width || !height)
        return {};
    return { width, height };
}
/**
 * 标记节点及其矢量子节点为已处理
 */
function markNodeAndVectorChildrenAsSeen(node, seenNodeIds, seenIconNodeIds) {
    if (!node || typeof node !== 'object') {
        return;
    }
    if (node.id) {
        seenNodeIds.add(node.id);
    }
    if (node.type === 'VECTOR' && node.id) {
        seenIconNodeIds.add(node.id);
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            markNodeAndVectorChildrenAsSeen(child, seenNodeIds, seenIconNodeIds);
        }
    }
}
/**
 * 递归收集表单控件子树中的前后缀容器节点
 */
function collectPrefixSuffixContainers(root) {
    const result = [];
    if (!root || typeof root !== 'object')
        return result;
    if (isPrefixSuffixIcon$1(root)) {
        result.push(root);
    }
    if (Array.isArray(root.children)) {
        for (const child of root.children) {
            result.push(...collectPrefixSuffixContainers(child));
        }
    }
    return result;
}
/**
 * 判断节点是否是前后缀图标（根据数据结构特征判断）
 * 前后缀图标特征：
 * 1. 节点名称明确包含前后缀关键词（"前缀"、"后缀"、"prefix"、"suffix"、"leading"、"trailing"）
 * 2. 通常是 FRAME 或 INSTANCE 类型
 * 3. 有 componentPropertyReferences 且包含 visible 属性（可选，但如果有会更准确）
 */
function isPrefixSuffixIcon$1(node) {
    if (!node || !node.name)
        return false;
    const nodeName = node.name.toLowerCase();
    // 1. 检查节点名称是否明确包含前后缀关键词
    const prefixSuffixKeywords = ['prefix', 'suffix', 'leading', 'trailing', '前缀', '后缀'];
    const hasPrefixSuffixName = prefixSuffixKeywords.some((keyword) => nodeName.includes(keyword));
    if (!hasPrefixSuffixName) {
        return false;
    }
    // 2. 检查节点类型（前后缀图标通常是 FRAME 或 INSTANCE）
    const isValidType = node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT';
    if (!isValidType) {
        return false;
    }
    // 3. 如果有 componentPropertyReferences，检查是否包含 visible 属性（这是前后缀图标的典型特征）
    if (node.componentPropertyReferences) {
        const hasVisibleProperty = 'visible' in node.componentPropertyReferences;
        if (hasVisibleProperty) {
            return true;
        }
    }
    // 4. 如果名称匹配且类型正确，也认为是前后缀图标（即使没有 componentPropertyReferences）
    return true;
}
/**
 * 检查是否在按钮或输入容器中
 */
function isInButtonOrInputContainer(node, parentNode, ancestorNodes = []) {
    const nodeName = (node?.name || '').toLowerCase();
    const isButtonComponent = nodeName.includes('button') || nodeName.includes('btn') || nodeName.includes('按钮');
    const isInputComponent = nodeName.includes('input') || nodeName.includes('输入') || nodeName.includes('文本框');
    // 如果节点本身就是按钮或输入组件，不跳过
    if (isButtonComponent || isInputComponent) {
        return false;
    }
    const containerKeywords = [
        'button', 'btn', '按钮',
        'input', '输入', '输入框', '文本框',
        'placeholder', '占位符',
        'text', '文本',
        'form', '表单',
        'field', '字段',
    ];
    const allAncestors = parentNode ? [parentNode, ...ancestorNodes] : ancestorNodes;
    for (const ancestor of allAncestors) {
        if (ancestor?.name) {
            const name = ancestor.name.toLowerCase();
            if (containerKeywords.some((keyword) => keyword && name.includes(keyword))) {
                return true;
            }
        }
    }
    return false;
}
/**
 * 提取图片引用
 */
function extractImageRefs(node, imageRefs, iconRefs, nodeIdMap, iconNodeIdMap, iconSizeMap, seenNodeIds, seenIconNodeIds, parentNode = null, ancestorNodes = [], nodeNames, wholeImageLayerNames) {
    if (!node || typeof node !== 'object') {
        return;
    }
    if (node.id && typeof node.name === 'string' && nodeNames) {
        if (!nodeNames.has(node.id)) {
            nodeNames.set(node.id, node.name);
        }
    }
    // 如果节点是表单控件（在 filter 阶段已标记），跳过该节点的图片提取
    // 但继续递归处理子节点，以保留前后缀图标
    if (node._formControlType) {
        // 表单控件内部只提取"前后缀容器"子树中的 icon（用于 antd Input 的 prefix/suffix），避免误抽控件自带图形
        const containers = collectPrefixSuffixContainers(node);
        const newAncestorNodes = parentNode ? [parentNode, ...ancestorNodes] : ancestorNodes;
        for (const c of containers) {
            extractImageRefs(c, imageRefs, iconRefs, nodeIdMap, iconNodeIdMap, iconSizeMap, seenNodeIds, seenIconNodeIds, node, newAncestorNodes, nodeNames, wholeImageLayerNames);
        }
        return;
    }
    if (Array.isArray(node.fills)) {
        for (const fill of node.fills) {
            if (fill?.type === 'IMAGE' && fill.imageRef) {
                imageRefs.add(fill.imageRef);
                if (node.id) {
                    nodeIdMap.set(fill.imageRef, node.id);
                }
            }
        }
    }
    // 配置名命中或上述 img 命名：容器与单层形状（含 RECTANGLE）整节点导出为图片
    if (matchesWholeRasterSliceName(node.name, wholeImageLayerNames) &&
        node.id &&
        !seenNodeIds.has(node.id) &&
        IMG_NAME_WHOLE_RENDER_TYPES.has(node.type)) {
        markNodeAndVectorChildrenAsSeen(node, seenNodeIds, seenIconNodeIds);
        const imageRef = `group_${node.id}`;
        imageRefs.add(imageRef);
        nodeIdMap.set(imageRef, node.id);
        seenNodeIds.add(node.id);
        return;
    }
    // 自动布局兼容：对于自动布局的 FRAME，如果有图片填充且有子节点，不要提取为 group
    if (node.type === 'FRAME' &&
        isAutoLayoutNode(node) &&
        hasImageFillBackground(node) &&
        Array.isArray(node.children) &&
        node.children.length > 0) ;
    // 图标提取：FRAME/COMPONENT/INSTANCE/GROUP 通过 icon_ 或 icon- 前缀判断
    if (node.id &&
        (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'GROUP') &&
        !seenNodeIds.has(node.id) &&
        !seenIconNodeIds.has(node.id)) {
        const nodeName = (node.name || '').toLowerCase();
        const isPrefixSuffixSlotContainer = isPrefixSuffixIcon$1(node);
        // 图标命名规则：icon_ 或 icon- 前缀
        const isIconByName = nodeName.startsWith('icon-') || nodeName.startsWith('icon_');
        if (!isPrefixSuffixSlotContainer && isIconByName) {
            markNodeAndVectorChildrenAsSeen(node, seenNodeIds, seenIconNodeIds);
            const iconRef = `icon_${node.id}`;
            iconRefs.add(iconRef);
            // 尝试提取内部矢量节点，以去除可能的容器边框/背景
            const innerId = pickInnerVectorIconId(node);
            iconNodeIdMap.set(iconRef, innerId || node.id);
            // 记录 icon 的真实尺寸：优先使用剥离后的 inner 矢量 bbox
            if (!iconSizeMap.has(iconRef)) {
                const target = innerId ? findNodeById(node, innerId) : undefined;
                const size = getNodeBoxSize(target || node);
                if (size.width && size.height) {
                    iconSizeMap.set(iconRef, { width: size.width, height: size.height });
                }
            }
            seenIconNodeIds.add(node.id);
            return;
        }
    }
    // INSTANCE/COMPONENT 图片提取：通过 icon_ 或 icon- 前缀判断
    if (node.id && (node.type === 'INSTANCE' || node.type === 'COMPONENT')) {
        const nodeName = (node.name || '').toLowerCase();
        // 图标命名规则：icon_ 或 icon- 前缀
        const isImageByName = nodeName.startsWith('icon-') || nodeName.startsWith('icon_');
        if (isImageByName && !seenNodeIds.has(node.id)) {
            markNodeAndVectorChildrenAsSeen(node, seenNodeIds, seenIconNodeIds);
            const imageRef = `instance_${node.id}`;
            imageRefs.add(imageRef);
            nodeIdMap.set(imageRef, node.id);
            seenNodeIds.add(node.id);
            return;
        }
    }
    // VECTOR 图标提取：通过 icon_ 或 icon- 前缀判断
    if (node.id && (node.type === 'VECTOR' || node.type === 'COMPONENT' || node.type === 'INSTANCE')) {
        if (seenNodeIds.has(node.id) || seenIconNodeIds.has(node.id)) {
            return;
        }
        if (node.type === 'TEXT' || (typeof node.characters === 'string' && node.characters.trim().length > 0)) {
            return;
        }
        const nodeName = (node.name || '').toLowerCase();
        const isPrefixSuffixSlotContainer = isPrefixSuffixIcon$1(node);
        // 图标命名规则：icon_ 或 icon- 前缀
        const isIconByName = nodeName.startsWith('icon-') || nodeName.startsWith('icon_');
        if (isInButtonOrInputContainer(node, parentNode, ancestorNodes) && !isIconByName) {
            return;
        }
        if (!isPrefixSuffixSlotContainer && isIconByName && node.id && !seenIconNodeIds.has(node.id)) {
            const iconRef = `icon_${node.id}`;
            iconRefs.add(iconRef);
            // 尝试提取内部矢量节点，以去除可能的容器边框/背景
            const innerId = pickInnerVectorIconId(node);
            iconNodeIdMap.set(iconRef, innerId || node.id);
            if (!iconSizeMap.has(iconRef)) {
                const target = innerId ? findNodeById(node, innerId) : undefined;
                const size = getNodeBoxSize(target || node);
                if (size.width && size.height) {
                    iconSizeMap.set(iconRef, { width: size.width, height: size.height });
                }
            }
            seenIconNodeIds.add(node.id);
            seenNodeIds.add(node.id);
        }
    }
    if (Array.isArray(node.children)) {
        const newAncestorNodes = parentNode ? [parentNode, ...ancestorNodes] : ancestorNodes;
        for (const child of node.children) {
            extractImageRefs(child, imageRefs, iconRefs, nodeIdMap, iconNodeIdMap, iconSizeMap, seenNodeIds, seenIconNodeIds, node, newAncestorNodes, nodeNames, wholeImageLayerNames);
        }
    }
}
/**
 * 提取图片引用并解析 URL（默认 Figma 直链；可选二次上传 OSS）
 */
async function extractAndDownloadImages(node, token, fileKey, ossConfig, skipOSSUpload = true, wholeImageLayerNames) {
    const imageRefs = new Set();
    const iconRefs = new Set();
    const nodeIdMap = new Map();
    const iconNodeIdMap = new Map();
    const iconSizeMap = new Map();
    const seenNodeIds = new Set();
    const seenIconNodeIds = new Set();
    const nodeNames = new Map();
    extractImageRefs(node, imageRefs, iconRefs, nodeIdMap, iconNodeIdMap, iconSizeMap, seenNodeIds, seenIconNodeIds, null, [], nodeNames, wholeImageLayerNames);
    const uniqueImageNodeIds = new Set();
    const uniqueIconNodeIds = new Map();
    const uniqueImageRefs = new Map();
    const uniqueIconRefs = new Map();
    // 同一 nodeId 可能同时存在 IMAGE fill 的 imageRef 与 group_/instance_ 渲染 ref（例如 img- 整图导出 + 背景图填充）。
    // 必须先收录渲染 ref，否则「整节点 PNG」会被 fill 抢先占位，下载与 AST 都会变成「只有填充图」而非合成结果。
    const isNodeRenderImageRef = (ref) => ref.startsWith('group_') || ref.startsWith('instance_');
    for (const imageRef of imageRefs) {
        if (!isNodeRenderImageRef(imageRef))
            continue;
        const nodeId = nodeIdMap.get(imageRef);
        if (nodeId && !uniqueImageNodeIds.has(nodeId)) {
            uniqueImageRefs.set(imageRef, nodeId);
            uniqueImageNodeIds.add(nodeId);
        }
    }
    for (const imageRef of imageRefs) {
        if (isNodeRenderImageRef(imageRef))
            continue;
        const nodeId = nodeIdMap.get(imageRef);
        if (nodeId && !uniqueImageNodeIds.has(nodeId)) {
            uniqueImageRefs.set(imageRef, nodeId);
            uniqueImageNodeIds.add(nodeId);
        }
    }
    for (const iconRef of iconRefs) {
        const nodeId = iconNodeIdMap.get(iconRef);
        if (nodeId && !uniqueIconNodeIds.has(nodeId)) {
            uniqueIconNodeIds.set(nodeId, iconRef);
            uniqueIconRefs.set(iconRef, nodeId);
        }
    }
    const finalIconRefs = new Map();
    for (const [nodeId, iconRef] of uniqueIconNodeIds.entries()) {
        finalIconRefs.set(iconRef, nodeId);
    }
    const imageRefToNodeId = {};
    for (const [imageRef, nodeId] of uniqueImageRefs.entries()) {
        // 如果同一个节点已经被识别为 icon，则只保留 SVG 版本，丢弃对应的 PNG
        if (uniqueIconNodeIds.has(nodeId)) {
            continue;
        }
        imageRefToNodeId[imageRef] = nodeId;
    }
    const iconRefToNodeId = {};
    for (const [iconRef, nodeId] of finalIconRefs.entries()) {
        iconRefToNodeId[iconRef] = nodeId;
    }
    // 构造 nodeId -> name 映射，用于图标判重时参考 name
    const nodeIdToName = {};
    for (const [id, name] of nodeNames.entries()) {
        nodeIdToName[id] = name;
    }
    const imagePathsMap = Object.keys(imageRefToNodeId).length > 0
        ? await downloadFigmaImages(token, fileKey, imageRefToNodeId, false, nodeIdToName, ossConfig, skipOSSUpload)
        : {};
    const iconPathsMap = Object.keys(iconRefToNodeId).length > 0
        ? await downloadFigmaImages(token, fileKey, iconRefToNodeId, true, nodeIdToName, ossConfig, skipOSSUpload)
        : {};
    const allPathsMap = { ...imagePathsMap, ...iconPathsMap };
    const imagePaths = [];
    const imageRefMap = {};
    const pathToIndex = new Map();
    let index = 0;
    const allRefs = [
        ...Array.from(uniqueImageRefs.keys()),
        ...Array.from(finalIconRefs.keys()),
    ];
    for (const ref of allRefs) {
        const imagePath = allPathsMap[ref];
        if (!imagePath)
            continue;
        let existingIndex = pathToIndex.get(imagePath);
        if (existingIndex === undefined) {
            existingIndex = index;
            imagePaths.push(imagePath);
            pathToIndex.set(imagePath, existingIndex);
            index++;
        }
        imageRefMap[ref] = existingIndex;
    }
    const imageMeta = {};
    for (const [ref, size] of iconSizeMap.entries()) {
        if (size?.width && size?.height) {
            imageMeta[ref] = { width: size.width, height: size.height };
        }
    }
    return { imageRefMap, imagePaths, imageMeta };
}

var desc = "以下组件都是基于antd二次封装，所以props都类似，antd版本是v5以上";
var UICheckbox = {
	type: "simple",
	usage: "<UICheckbox>复选项</UICheckbox>",
	imports: [
		"import { UICheckbox } from '@xybot/ui';"
	]
};
var UIDropdown = {
	type: "simple",
	usage: "<UIDropdown menu={{ items: [{ key: '1', label: '选项A' }] }}><button>下拉菜单</button></UIDropdown>",
	imports: [
		"import { UIDropdown } from '@xybot/ui';"
	]
};
var UIRadio = {
	type: "simple",
	usage: "<UIRadio>单选项</UIRadio>",
	imports: [
		"import { UIRadio } from '@xybot/ui';"
	]
};
var UISwitch = {
	type: "simple",
	usage: "<UISwitch />",
	imports: [
		"import { UISwitch } from '@xybot/ui';"
	]
};
var UIButton = {
	type: "simple",
	usage: "<UIButton type='base'>按钮</UIButton>",
	imports: [
		"import { UIButton } from '@xybot/ui';"
	]
};
var UIInput = {
	type: "simple",
	usage: "<UIInput placeholder=\"请输入\" />",
	imports: [
		"import { UIInput } from '@xybot/ui';"
	]
};
var UISelect = {
	type: "simple",
	usage: "<UISelect options={[{ label: '选项1', value: '1' }]} placeholder=\"请选择\" />",
	imports: [
		"import { UISelect } from '@xybot/ui';"
	]
};
var UITag = {
	type: "simple",
	usage: "<UITag>标签</UITag>",
	imports: [
		"import { UITag } from '@xybot/ui';"
	]
};
var UILink = {
	type: "simple",
	usage: "<UILink href=\"https://example.com\">示例链接</UILink>",
	imports: [
		"import { UILink } from '@xybot/ui';"
	]
};
var UIDivider = {
	type: "simple",
	usage: "<UIDivider />",
	imports: [
		"import { UIDivider } from '@xybot/ui';"
	]
};
var UIModal = {
	type: "simple",
	usage: "<UIModal open={true} onOk={() => {}} onCancel={() => {}}>内容</UIModal>",
	imports: [
		"import { UIModal } from '@xybot/ui';"
	]
};
var UIMenu = {
	type: "simple",
	usage: "<UIMenu items={[{ key: '1', label: '菜单项' }]} />",
	imports: [
		"import { UIMenu } from '@xybot/ui';"
	]
};
var UITable = {
	type: "simple",
	usage: "<UITable columns={[{ title: '姓名', dataIndex: 'name', key: 'name' }]} dataSource={[{ key: '1', name: 'Tom' }]} />",
	imports: [
		"import { UITable } from '@xybot/ui';"
	]
};
var UIAlert = {
	type: "simple",
	usage: "<UIAlert type=\"success\" message=\"操作成功\" />",
	imports: [
		"import { UIAlert } from '@xybot/ui';"
	]
};
var UITabs = {
	type: "simple",
	usage: "<UITabs type='segment' items={[{ key: '1', label: '标签1', children: '' }]} />",
	imports: [
		"import { UITabs } from '@xybot/ui';"
	]
};
var UIContainer = {
	type: "simple",
	usage: "<UIContainer>内容</UIContainer>",
	imports: [
		"import { UIContainer } from '@xybot/ui';"
	]
};
var UIDatePicker = {
	type: "simple",
	usage: "<UIDatePicker />",
	imports: [
		"import { UIDatePicker } from '@xybot/ui';"
	]
};
var UITooltip = {
	type: "simple",
	usage: "<UITooltip title=\"提示\"><span>悬停查看</span></UITooltip>",
	imports: [
		"import { UITooltip } from '@xybot/ui';"
	]
};
var UIPopover = {
	type: "simple",
	usage: "<UIPopover content={<div>内容</div>}><span>悬停查看</span></UIPopover>",
	imports: [
		"import { UIPopover } from '@xybot/ui';"
	]
};
var UISpin = {
	type: "simple",
	usage: "<UISpin spinning>加载中</UISpin>",
	imports: [
		"import { UISpin } from '@xybot/ui';"
	]
};
var AvatarGroup = {
	type: "simple",
	usage: "<AvatarGroup avatarList={[{ name: 'User 1' }, { name: 'User 2' }]} />",
	imports: [
		"import { AvatarGroup } from '@xybot/ui';"
	]
};
var ScrollContainer = {
	type: "simple",
	usage: "<ScrollContainer style={{ height: 200 }}>内容</ScrollContainer>",
	imports: [
		"import { ScrollContainer } from '@xybot/ui';"
	]
};
var ScrollArea = {
	type: "simple",
	usage: "<ScrollArea style={{ height: 200 }}>内容</ScrollArea>",
	imports: [
		"import { ScrollArea } from '@xybot/ui';"
	]
};
var UIAvatar = {
	type: "simple",
	usage: "<UIAvatar name=\"User\" />",
	imports: [
		"import { UIAvatar } from '@xybot/ui';"
	]
};
var CustomAvatar = {
	type: "simple",
	usage: "<CustomAvatar src=\"https://via.placeholder.com/40\" name=\"User\" />",
	imports: [
		"import { CustomAvatar } from '@xybot/ui';"
	]
};
var TipTapEditor = {
	type: "complex",
	usage: "<TipTapEditor content=\"<p>Hello</p>\" onChange={() => {}} />",
	imports: [
		"import { TipTapEditor } from '@xybot/ui';"
	],
	definition: "需在应用引入 TipTapEditor 相关样式与扩展资源。"
};
var CommentTree = {
	type: "simple",
	usage: "<CommentTree items={[{ id: 1, name: 'User', title: 'User', content: '评论内容', time: Date.now(), children: [] }]} onReplay={() => {}} />",
	imports: [
		"import { CommentTree } from '@xybot/ui';"
	]
};
var CustomModal = {
	type: "simple",
	usage: "<CustomModal open={true} customModalProps={{ title: '标题', onCancel: () => {} }}>内容</CustomModal>",
	imports: [
		"import { CustomModal } from '@xybot/ui';"
	]
};
var components = {
	desc: desc,
	UICheckbox: UICheckbox,
	UIDropdown: UIDropdown,
	UIRadio: UIRadio,
	UISwitch: UISwitch,
	UIButton: UIButton,
	UIInput: UIInput,
	UISelect: UISelect,
	UITag: UITag,
	UILink: UILink,
	UIDivider: UIDivider,
	UIModal: UIModal,
	UIMenu: UIMenu,
	UITable: UITable,
	UIAlert: UIAlert,
	UITabs: UITabs,
	UIContainer: UIContainer,
	UIDatePicker: UIDatePicker,
	UITooltip: UITooltip,
	UIPopover: UIPopover,
	UISpin: UISpin,
	AvatarGroup: AvatarGroup,
	ScrollContainer: ScrollContainer,
	ScrollArea: ScrollArea,
	UIAvatar: UIAvatar,
	CustomAvatar: CustomAvatar,
	TipTapEditor: TipTapEditor,
	CommentTree: CommentTree,
	CustomModal: CustomModal
};

/**
 * 节点处理
 */
const COMPONENT_NAME_SET$1 = new Set(Object.keys(components));
/** 与表单 input 前缀槽命名一致（含「前缀」Frame、左侧图标区域等） */
const INPUT_PREFIX_SLOT_KEYWORDS = ['prefix', 'leading', '前缀', '左侧'];
const INPUT_SUFFIX_SLOT_KEYWORDS = ['suffix', 'trailing', '后缀', '右侧'];
/**
 * 如果节点是组件库里的组件实例，返回组件名（用于覆盖输出 ast.type）。
 * 识别规则：
 * - 优先使用 Figma 命名约定：xxx#ComponentName
 * - 兼容直接命名为 ComponentName
 * - 必须在 components.json 中存在对应 key
 */
function resolveLibraryComponentType(node) {
    if (!node || typeof node !== 'object')
        return undefined;
    // filter 阶段可能已经通过 componentId -> components.name 解析出组件库组件名
    if (typeof node._libraryComponentType === 'string' && node._libraryComponentType.trim()) {
        const preset = String(node._libraryComponentType).trim();
        if (COMPONENT_NAME_SET$1.has(preset)) {
            markNeedsXybotUi();
            return preset;
        }
        return undefined;
    }
    // 只要节点名本身能命中 components.json（例如 "UIButton" 或 "xxx#UIButton"），就允许映射
    // 这样可以覆盖“不是 INSTANCE，但设计稿按组件名规范命名”的情况
    if (typeof node.name === 'string') {
        const raw = node.name.trim();
        if (raw) {
            const candidate = raw.includes('#') ? raw.split('#').pop().trim() : raw;
            if (candidate && COMPONENT_NAME_SET$1.has(candidate)) {
                markNeedsXybotUi();
                return candidate;
            }
        }
    }
    // 组件库组件通常是 INSTANCE（或有 componentId）
    if (node.type !== 'INSTANCE' && !node.componentId)
        return undefined;
    return undefined;
}
/**
 * 将通用类型（button/checkbox/...）映射到 UI 组件名（UIButton/UICheckbox/...）。
 *
 * 说明：
 * - 这不是“识别为组件库实例”，只是输出层面的别名映射；
 * - 只在 components.json 中存在对应 key 时才生效；
 * - 内部逻辑继续依赖 __baseType（attachBaseType）进行判断，不改变处理流程。
 */
function resolveUiAliasType(baseType) {
    const aliasMap = {
    // button: 'UIButton',
    // input: 'UIInput',
    // select: 'UISelect',
    // checkbox: 'UICheckbox',
    // radio: 'UIRadio',
    // switch: 'UISwitch',
    };
    const alias = aliasMap[String(baseType)];
    if (!alias)
        return undefined;
    return COMPONENT_NAME_SET$1.has(alias) ? alias : undefined;
}
/**
 * 命中组件库类型时，把 Figma `components[componentId].name`（filter 已写入 `_componentDesc`）落到 AST，便于生码映射 props。
 */
function resolveComponentDescForAst(node, componentsMap) {
    const fromFilter = typeof node._componentDesc === 'string' ? String(node._componentDesc).trim() : '';
    if (fromFilter)
        return fromFilter;
    if (!componentsMap || typeof componentsMap !== 'object')
        return undefined;
    const isInstance = node?.type === 'INSTANCE';
    const isComponent = node?.type === 'COMPONENT';
    if (!isInstance && !isComponent)
        return undefined;
    const key = isInstance ? node.componentId : node.id;
    if (typeof key !== 'string' || !key)
        return undefined;
    const raw = componentsMap[key]?.name;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
function attachLibraryComponentDesc(astNode, node, libraryComponentType, componentsMap) {
    if (!libraryComponentType)
        return;
    const desc = resolveComponentDescForAst(node, componentsMap);
    if (desc)
        astNode.componentDesc = desc;
}
function stripStyleLayoutIfComponentType(astNode) {
    if (!astNode)
        return;
    const typeName = String(astNode.type || '').trim();
    if (!typeName)
        return;
    // 组件库组件：统一去掉 style/layout，避免大模型误用布局样式
    // 仅保留极少数必须字段（例如 UIModal 的 width）以满足业务渲染需求。
    if (!COMPONENT_NAME_SET$1.has(typeName))
        return;
    // 特例：UIModal 需要保留 width（用于传给组件 width 属性），其余 style/layout 去掉
    if (typeName === 'UIModal') {
        if (astNode.style) {
            const width = astNode.style.width;
            astNode.style = {};
            if (width !== undefined)
                astNode.style.width = width;
        }
        delete astNode.layout;
        return;
    }
    delete astNode.style;
    delete astNode.layout;
}
/**
 * img-/wholeImage 整图节点已被栅格化为单张图片，去掉会重复叠加的装饰样式。
 */
function sanitizeWholeRasterImageStyle(style) {
    const next = { ...style };
    delete next.background;
    delete next.borderColor;
    delete next.borderWidth;
    delete next.borderWidthSides;
    delete next.borderStyle;
    delete next.filter;
    delete next.backdropFilter;
    return next;
}
function applyAbsolutePositionFromConstraints(parentNode, childNode, childAst) {
    const s = childAst.style;
    if (!parentNode || !childNode?.constraints)
        return false;
    if (!s || typeof s.width !== 'number' || typeof s.height !== 'number')
        return false;
    // x/y 可能在 style-extractor 中提取了，也可能没提取（如果位置相关属性被优化掉了）
    // 但我们需要计算 absolute position，所以最好直接用 raw node 的 absoluteBoundingBox
    // 不过 style-extractor 里确实提取了 x, y from bbox. 
    // 为保险起见，我们重新计算 relative position based on bbox, 
    // 或者如果 style 里有 x/y 就用 style 的 (style.x/y 来自 absoluteBoundingBox)
    if (typeof s.x !== 'number' || typeof s.y !== 'number')
        return false;
    const parentBox = parentNode.absoluteBoundingBox;
    if (!parentBox)
        return false;
    const px = Math.round(parentBox.x || 0);
    const py = Math.round(parentBox.y || 0);
    const pw = Math.round(Math.abs(parentBox.width || 0));
    const ph = Math.round(Math.abs(parentBox.height || 0));
    if (!pw || !ph)
        return false;
    const left = Math.round(s.x - px);
    const top = Math.round(s.y - py);
    const right = Math.round(px + pw - (s.x + s.width));
    const bottom = Math.round(py + ph - (s.y + s.height));
    const h = String(childNode.constraints.horizontal || '').toUpperCase();
    const v = String(childNode.constraints.vertical || '').toUpperCase();
    // 仅当明确给出了 RIGHT/TOP/BOTTOM/LEFT 的约束时，才转成 absolute
    // 这样不会影响普通 auto-layout 的子节点流式排版
    const shouldAbs = h === 'RIGHT' || h === 'LEFT' || v === 'TOP' || v === 'BOTTOM';
    if (!shouldAbs)
        return false;
    s.position = 'absolute';
    if (v === 'TOP')
        s.top = top;
    else if (v === 'BOTTOM')
        s.bottom = bottom;
    else
        s.top = top;
    if (h === 'RIGHT')
        s.right = right;
    else if (h === 'LEFT')
        s.left = left;
    else
        s.left = left;
    // absolute 子节点的 x/y 对最终布局没用，避免大模型误用
    delete s.x;
    delete s.y;
    return true;
}
/**
 * 与父级左上角对齐（left/top 均为 0）且无有效 right/bottom inset 时，absolute 与默认占位等价，去掉以免误导生码。
 */
function stripRedundantAbsoluteOrigin(_style) {
    // 已废弃：left=0, top=0 可能是有效的绝对定位（如纯背景覆盖），不应视为冗余移除。
    // 保留空函数体以兼容调用方，不做任何操作。
}
/**
 * 给 AST 节点挂一个不可枚举的 baseType，确保内部逻辑仍按原始类型判断；
 * JSON.stringify 不会包含该字段，从而不影响输出结构。
 */
function attachBaseType(astNode, baseType) {
    Object.defineProperty(astNode, '__baseType', {
        value: baseType,
        enumerable: false,
        configurable: true,
    });
}
/**
 * 给 AST 节点挂一个不可枚举的 figmaName，仅用于结构识别（Title/Footer）。
 * JSON.stringify 不会包含该字段，从而不影响输出结构。
 */
function attachFigmaName(astNode, figmaName) {
    const name = typeof figmaName === 'string' ? figmaName.trim() : '';
    Object.defineProperty(astNode, '__figmaName', {
        value: name,
        enumerable: false,
        configurable: true,
    });
}
function getFigmaName(astNode) {
    const v = astNode.__figmaName;
    return typeof v === 'string' ? v : '';
}
function isModalLikeComponentTypeName(typeName) {
    const t = String(typeName || '').trim().toLowerCase();
    return t.includes('modal') || t.includes('drawer');
}
function findFirstTextDeep(node) {
    if (typeof node.text === 'string' && node.text.trim())
        return node.text;
    if (Array.isArray(node.textRuns) && node.textRuns.length > 0) {
        const merged = node.textRuns
            .map((run) => (typeof run?.text === 'string' ? run.text : ''))
            .join('')
            .trim();
        if (merged)
            return merged;
    }
    if (!node.children || node.children.length === 0)
        return undefined;
    for (const c of node.children) {
        const t = findFirstTextDeep(c);
        if (t)
            return t;
    }
    return undefined;
}
function hasMeaningfulContentForModal(node) {
    if (!node || typeof node !== 'object')
        return false;
    if (typeof node.text === 'string' && node.text.trim())
        return true;
    if (typeof node.placeholder === 'string' && node.placeholder.trim())
        return true;
    if (node.asset || node.prefixAsset || node.suffixAsset)
        return true;
    if (node.prefixSlotAst || node.suffixSlotAst)
        return true;
    // 有明显可见样式（背景/边框/阴影/透明度）就认为是有效内容，避免误删分割/背景块
    const s = node.style;
    if (s) {
        if (s.background !== undefined)
            return true;
        if (s.borderWidth !== undefined)
            return true;
        if (s.borderWidthSides?.some((w) => w > 0))
            return true;
        if (s.shadow !== undefined)
            return true;
        if (s.opacity !== undefined)
            return true;
    }
    // 不是纯布局容器类型，则通常是可渲染组件/元素
    const t = String(node.type || '');
    if (t && t !== 'Row' && t !== 'Column' && t !== 'container')
        return true;
    if (Array.isArray(node.children) && node.children.length > 0) {
        return node.children.some((c) => hasMeaningfulContentForModal(c));
    }
    return false;
}
/**
 * 仅基于 Figma 明确标识（name === Title/Footer/Heading）做精准抽取：
 * - Title/Heading：提取文本到 ast.modalTitle，并移除该节点
 * - Footer：直接移除该节点（使用组件默认 footer，不需要传递）
 *
 * 不做任何“看起来像 footer”之类的特征判断。
 */
function processModalLikeChildrenByMarkers(astNode) {
    const typeName = String(astNode.type || '').trim();
    if (!isModalLikeComponentTypeName(typeName))
        return;
    astNode.footer = null;
    if (!Array.isArray(astNode.children) || astNode.children.length === 0)
        return;
    const isTitleMarker = (n) => {
        const name = getFigmaName(n).trim().toLowerCase();
        return name === 'title' || name === 'heading';
    };
    const isFooterMarker = (n) => {
        const name = getFigmaName(n).trim().toLowerCase();
        return name === 'footer';
    };
    // 1) 移除所有 Footer 标识节点（精准），并记录是否发生过移除
    let removedFooter = false;
    const removeFooterDeep = (node) => {
        if (!node.children || node.children.length === 0)
            return;
        if (node.children.some((c) => isFooterMarker(c)))
            removedFooter = true;
        node.children = node.children.filter((c) => !isFooterMarker(c));
        node.children.forEach(removeFooterDeep);
        if (node.children.length === 0)
            delete node.children;
    };
    removeFooterDeep(astNode);
    astNode.footer = removedFooter ? true : null;
    // 2) 抽取第一个 Title/Heading 标识节点（精准）
    if (!astNode.modalTitle) {
        const removeFirstTitleDeep = (node) => {
            if (!node.children || node.children.length === 0)
                return undefined;
            for (let i = 0; i < node.children.length; i++) {
                const c = node.children[i];
                if (isTitleMarker(c)) {
                    const t = findFirstTextDeep(c);
                    node.children.splice(i, 1);
                    if (node.children.length === 0)
                        delete node.children;
                    return t;
                }
                const t2 = removeFirstTitleDeep(c);
                if (t2)
                    return t2;
            }
            return undefined;
        };
        const titleText = removeFirstTitleDeep(astNode);
        if (titleText) {
            astNode.modalTitle = titleText;
        }
    }
    // 3) 方案 A：抽取出 modalTitle 后，删除最前面的“空标题栏壳子”（只移除连续的前缀空节点，避免影响正文）
    if (astNode.modalTitle && Array.isArray(astNode.children) && astNode.children.length > 0) {
        while (astNode.children.length > 0 && !hasMeaningfulContentForModal(astNode.children[0])) {
            astNode.children.shift();
        }
        if (astNode.children.length === 0)
            delete astNode.children;
    }
}
function stripStyleAndLayoutDeep(node) {
    delete node.style;
    delete node.layout;
    if (node.children) {
        node.children.forEach(stripStyleAndLayoutDeep);
    }
}
/**
 * 精简节点，只保留需要的字段
 */
function pruneNode(node, nodeFieldWhitelist) {
    if (!node || typeof node !== 'object' || node.visible === false) {
        return null;
    }
    const cleaned = {};
    for (const field of nodeFieldWhitelist) {
        if (node[field] !== undefined) {
            cleaned[field] = node[field];
        }
    }
    if (Array.isArray(node.children)) {
        const nextChildren = node.children
            .map((child) => pruneNode(child, nodeFieldWhitelist))
            .filter((child) => Boolean(child));
        if (nextChildren.length > 0) {
            cleaned.children = nextChildren;
        }
    }
    return cleaned;
}
/**
 * 检查节点是否有可渲染尺寸
 */
function hasRenderableSize(node) {
    if (!node?.absoluteBoundingBox)
        return true;
    const width = Math.abs(node.absoluteBoundingBox.width || 0);
    const height = Math.abs(node.absoluteBoundingBox.height || 0);
    return width > MIN_RENDERABLE_SIZE || height > MIN_RENDERABLE_SIZE;
}
/**
 * 检查节点名称是否匹配关键词
 */
function matchesNodeName$1(node, keywords) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase();
    return keywords.some(keyword => name.includes(keyword.toLowerCase()));
}
/**
 * 判断是否是背景节点
 */
function isBackgroundNode$1(node) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase();
    const backgroundKeywords = ['bg', 'background', '背景', '背景图'];
    return backgroundKeywords.some(keyword => name.includes(keyword));
}
/**
 * 解析节点类型
 */
function resolveNodeType(node, asset) {
    if (node.type === 'TEXT') {
        return 'text';
    }
    // 优先检查是否有 filter 阶段设置的表单控件标记
    if (node._formControlType) {
        const formType = node._formControlType.toLowerCase();
        if (formType === 'input' || formType === 'checkbox' || formType === 'select' || formType === 'radio' || formType === 'switch' || formType === 'textarea') {
            return formType;
        }
    }
    // 表单控件优先按名称判定
    const inputKeywords = ['input', '文本输入', '输入框', '文本框', 'textfield', 'text field'];
    if (matchesNodeName$1(node, inputKeywords)) {
        return 'input';
    }
    const checkboxKeywords = ['checkbox', '复选框', 'check box', '勾选', '选择框'];
    if (matchesNodeName$1(node, checkboxKeywords)) {
        return 'checkbox';
    }
    // 检查是否是导航链接（导航链接即使包含 dropdown 也不应该是 select）
    const navKeywords = ['nav', 'link', '导航', '菜单', 'menu'];
    const isNavLink = matchesNodeName$1(node, navKeywords);
    const selectKeywords = ['select', '选择器', 'drop-down', 'dropdown', '下拉框', '下拉菜单'];
    // 如果是导航链接，即使包含 select/dropdown 关键词也不识别为 select
    // 特别处理：Nav Link Dropdown 这种导航下拉菜单应该是 container，不是 select
    if (!isNavLink && matchesNodeName$1(node, selectKeywords)) {
        return 'select';
    }
    const textareaKeywords = ['textarea', '文本域', '多行输入', 'text area', 'text-area', '多行文本框', '多行文本输入'];
    if (matchesNodeName$1(node, textareaKeywords)) {
        return 'textarea';
    }
    // 先处理资产/矢量，防止图标被按钮关键词误判
    if (asset && asset.source && asset.source !== 'fill') {
        if (asset.source === 'icon') {
            return 'icon';
        }
        return 'image';
    }
    if (node.type === 'VECTOR' || node.type === 'ELLIPSE' || node.type === 'POLYGON' || node.type === 'STAR') {
        return 'icon';
    }
    if (node.type === 'LINE') {
        return 'rect';
    }
    if (node.type === 'RECTANGLE' && Array.isArray(node.fills) && node.fills.some((fill) => fill?.type === 'IMAGE')) {
        return 'image';
    }
    // 按钮关键词放在最后，避免图标误判
    const buttonKeywords = ['button', '按钮', 'btn'];
    if (matchesNodeName$1(node, buttonKeywords)) {
        return 'button';
    }
    return 'container';
}
/**
 * 解析节点资源
 */
function resolveNodeAsset(node, imageRefMap, imagePaths, imageMeta) {
    if (!node)
        return undefined;
    // 表单控件不使用 asset
    if (node._formControlType) {
        return undefined;
    }
    // 整节点渲染（icon_/group_/instance_）优先于 fills 里的 IMAGE：否则 img- 等「整图导出」与背景填充并存时，
    // 会错误地使用「仅填充位图」而非 Figma 合成后的整帧（与手动导出选 Frame 不一致）。
    if (node.id) {
        const fallbackRefs = [
            { ref: `icon_${node.id}`, source: 'icon', mode: 'contain' },
            { ref: `group_${node.id}`, source: 'group', mode: 'cover' },
            { ref: `instance_${node.id}`, source: 'instance', mode: 'contain' },
        ];
        for (const { ref, source, mode } of fallbackRefs) {
            const index = imageRefMap[ref];
            if (index !== undefined && imagePaths[index]) {
                const meta = imageMeta?.[ref];
                return {
                    index,
                    path: imagePaths[index],
                    mode,
                    source,
                    width: meta?.width,
                    height: meta?.height,
                };
            }
        }
    }
    if (Array.isArray(node.fills)) {
        for (const fill of node.fills) {
            if (fill?.type === 'IMAGE' && fill.imageRef) {
                const index = imageRefMap[fill.imageRef];
                if (index !== undefined && imagePaths[index]) {
                    let mode;
                    if (fill.scaleMode === 'FILL' || fill.scaleMode === 'CROP')
                        mode = 'cover';
                    else if (fill.scaleMode === 'FIT')
                        mode = 'contain';
                    else if (fill.scaleMode === 'TILE')
                        mode = 'fill';
                    else if (fill.scaleMode)
                        mode = fill.scaleMode.toLowerCase();
                    return {
                        index,
                        path: imagePaths[index],
                        mode,
                        transform: Array.isArray(fill.imageTransform) ? fill.imageTransform : undefined,
                        source: 'fill',
                    };
                }
            }
        }
    }
    return undefined;
}
/**
 * 创建清理后的 AST 节点
 */
function createCleanAst(node, imageRefMap, imagePaths, parent, imageMeta, wholeImageLayerNames, 
/** Figma API `nodes[*].components`：用于 componentId → 变体名（与 `_componentDesc` 二选一或补全） */
componentsMap) {
    if (!node || !hasRenderableSize(node)) {
        return null;
    }
    // img-/wholeImage 整图切片：与 extractImageRefs 的 group_${id} 一致，AST 只输出单层 image，不再递归子树（避免子节点 UIButton 等再走组件库）
    if (isWholeRasterSliceNode(node, wholeImageLayerNames)) {
        const groupAsset = resolveNodeAsset(node, imageRefMap, imagePaths, imageMeta);
        if (groupAsset?.source === 'group') {
            const astNode = {
                type: 'image',
                id: makeFigmaAstId(node),
            };
            attachBaseType(astNode, 'image');
            attachFigmaName(astNode, node.name);
            const st = extractNodeStyle(node);
            if (st) {
                const sanitizedStyle = sanitizeWholeRasterImageStyle(st);
                if (Object.keys(sanitizedStyle).length > 0) {
                    astNode.style = sanitizedStyle;
                }
            }
            const lo = extractLayout(node);
            if (lo)
                astNode.layout = lo;
            astNode.asset = {
                index: groupAsset.index,
                path: groupAsset.path,
                mode: groupAsset.mode,
                width: groupAsset.width,
                height: groupAsset.height,
                ...(groupAsset.transform ? { transform: groupAsset.transform } : {}),
            };
            processModalLikeChildrenByMarkers(astNode);
            stripStyleLayoutIfComponentType(astNode);
            return astNode;
        }
    }
    const libraryComponentType = resolveLibraryComponentType(node);
    // 如果是表单控件（在 filter 阶段已标记），特殊处理
    if (node._formControlType) {
        const baseType = resolveNodeType(node, undefined);
        const uiAliasType = resolveUiAliasType(baseType);
        const astNode = {
            type: (libraryComponentType ?? uiAliasType ?? baseType),
            id: makeFigmaAstId(node),
        };
        attachBaseType(astNode, baseType);
        attachFigmaName(astNode, node.name);
        attachLibraryComponentDesc(astNode, node, libraryComponentType, componentsMap);
        const formControlType = baseType;
        // input/select：只保留 style 的 width 和 height，不添加 layout
        if (formControlType === 'input' || formControlType === 'select') {
            const fullStyle = extractNodeStyle(node);
            if (fullStyle) {
                const inputStyle = {};
                if (fullStyle.width !== undefined) {
                    inputStyle.width = fullStyle.width;
                }
                if (fullStyle.height !== undefined) {
                    inputStyle.height = fullStyle.height;
                }
                if (Object.keys(inputStyle).length > 0) {
                    astNode.style = inputStyle;
                }
            }
        }
        // input/textarea：placeholder 不作为 children，单独存储
        if ((formControlType === 'input' || formControlType === 'textarea') && typeof node._placeholder === 'string') {
            astNode.placeholder = node._placeholder.replace(/\n/g, '');
        }
        // 提取 prefix/suffix icon（用于 antd Input 的 prefix/suffix），并且 input/textarea 不输出 children
        if (formControlType === 'input' || formControlType === 'textarea') {
            const prefixSlot = findPrefixSuffixSlot(node, 'prefix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
            const suffixSlot = findPrefixSuffixSlot(node, 'suffix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
            attachPrefixSuffixFromSlots(astNode, prefixSlot, suffixSlot, node, imageRefMap, imagePaths, imageMeta, wholeImageLayerNames, componentsMap);
            stripStyleLayoutIfComponentType(astNode);
            return astNode;
        }
        // select：如果子节点是 input，提取其 placeholder、prefixAsset、suffixAsset 到 select 节点上
        if (formControlType === 'select') {
            if (Array.isArray(node.children) && node.children.length > 0) {
                // 查找 input 类型的子节点
                const inputChild = node.children.find((child) => child._formControlType === 'input');
                if (inputChild) {
                    // 提取 placeholder
                    if (typeof inputChild._placeholder === 'string') {
                        astNode.placeholder = inputChild._placeholder.replace(/\n/g, '');
                    }
                    const prefixSlot = findPrefixSuffixSlot(inputChild, 'prefix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
                    const suffixSlot = findPrefixSuffixSlot(inputChild, 'suffix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
                    attachPrefixSuffixFromSlots(astNode, prefixSlot, suffixSlot, node, imageRefMap, imagePaths, imageMeta, wholeImageLayerNames, componentsMap);
                    // select 不保留 input 子节点，只保留其他非 input 的 children
                    const otherChildren = node.children.filter((child) => child._formControlType !== 'input');
                    if (otherChildren.length > 0) {
                        const processedChildren = otherChildren
                            .map((child) => {
                            const childAst = createCleanAst(child, imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
                            if (childAst) {
                                delete childAst.style;
                                delete childAst.layout;
                                if (childAst.children) {
                                    const removeStyleAndLayout = (node) => {
                                        delete node.style;
                                        delete node.layout;
                                        if (node.children) {
                                            node.children.forEach(removeStyleAndLayout);
                                        }
                                    };
                                    childAst.children.forEach(removeStyleAndLayout);
                                }
                            }
                            return childAst;
                        })
                            .filter((child) => Boolean(child));
                        if (processedChildren.length > 0) {
                            astNode.children = processedChildren;
                        }
                    }
                }
                else {
                    // 没有 input 子节点，正常处理 children
                    const processedChildren = node.children
                        .map((child) => {
                        const childAst = createCleanAst(child, imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
                        if (childAst) {
                            delete childAst.style;
                            delete childAst.layout;
                            if (childAst.children) {
                                const removeStyleAndLayout = (node) => {
                                    delete node.style;
                                    delete node.layout;
                                    if (node.children) {
                                        node.children.forEach(removeStyleAndLayout);
                                    }
                                };
                                childAst.children.forEach(removeStyleAndLayout);
                            }
                        }
                        return childAst;
                    })
                        .filter((child) => Boolean(child));
                    if (processedChildren.length > 0) {
                        astNode.children = processedChildren;
                    }
                }
            }
            stripStyleLayoutIfComponentType(astNode);
            return astNode;
        }
        // checkbox、radio、textarea、switch 等：保留 children，但去掉 children 的 style 和 layout
        let children;
        if (Array.isArray(node.children) && node.children.length > 0) {
            const processedChildren = node.children
                .map((child) => {
                const childAst = createCleanAst(child, imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
                if (childAst) {
                    // 去掉 children 的 style 和 layout
                    delete childAst.style;
                    delete childAst.layout;
                    // 递归处理子节点的 children，也去掉 style 和 layout
                    if (childAst.children) {
                        childAst.children.forEach(stripStyleAndLayoutDeep);
                    }
                }
                return childAst;
            })
                .filter((child) => Boolean(child));
            if (processedChildren.length > 0) {
                children = processedChildren;
            }
        }
        if (children && children.length > 0) {
            astNode.children = children;
        }
        stripStyleLayoutIfComponentType(astNode);
        return astNode;
    }
    const asset = resolveNodeAsset(node, imageRefMap, imagePaths, imageMeta);
    // 如果是 TEXT 节点，检查是否所有 fills 都不可见
    if (node.type === 'TEXT') {
        const fillCandidates = [
            ...(Array.isArray(node.background) ? node.background : []),
            ...(Array.isArray(node.fills) ? node.fills : []),
        ];
        // 对于 VARIABLE_ALIAS 类型的 fill，如果没有 visible 属性，应该视为可见
        const hasVisibleFill = fillCandidates.some((fill) => {
            if (!fill)
                return false;
            // VARIABLE_ALIAS 类型默认可见
            if (fill.type === 'VARIABLE_ALIAS')
                return true;
            // 其他类型检查 visible 属性
            return fill.visible !== false;
        });
        // 如果没有可见的 fill，且没有 backgroundColor，则这个文本节点不可见，应该被过滤
        // 但是"提示"节点下的 Value 节点特殊处理，总是保留（因为它们是提示信息，即使 fills 不可见也应该显示）
        const isHintValueNode = node.name === 'Value' && parent?.name === '提示';
        if (!hasVisibleFill && !node.backgroundColor && !isHintValueNode) {
            return null;
        }
    }
    // 第一个子节点为 VECTOR 且图层名命中 iconfont：fontClass + 矢量填充色；尺寸用 fontSize（字图标不按 width/height/x/y）
    if (!libraryComponentType &&
        Array.isArray(node.children) &&
        node.children.length > 0 &&
        node.children[0]?.type === 'VECTOR') {
        const fontClass = getIconFontClassName(typeof node.name === 'string' ? node.name : '', node);
        if (fontClass) {
            markHasIconfont();
            const only = node.children[0];
            const astNode = { type: 'iconfont', fontClass, id: makeFigmaAstId(node) };
            attachBaseType(astNode, 'iconfont');
            attachFigmaName(astNode, node.name);
            const iconStyle = {};
            const bbox = node.absoluteBoundingBox;
            if (bbox) {
                const w = Math.round(Math.abs(bbox.width || 0));
                const h = Math.round(Math.abs(bbox.height || 0));
                if (w > 0 && h > 0) {
                    iconStyle.fontSize = Math.min(w, h);
                }
                else if (h > 0) {
                    iconStyle.fontSize = h;
                }
                else if (w > 0) {
                    iconStyle.fontSize = w;
                }
            }
            const tint = extractVectorIconTint(only);
            if (tint)
                iconStyle.color = tint;
            if (Object.keys(iconStyle).length > 0)
                astNode.style = iconStyle;
            return astNode;
        }
    }
    const baseType = resolveNodeType(node, asset);
    const outputType = baseType;
    const uiAliasType = resolveUiAliasType(outputType);
    const astNode = {
        type: (libraryComponentType ?? uiAliasType ?? outputType),
        id: makeFigmaAstId(node),
    };
    attachBaseType(astNode, outputType);
    attachFigmaName(astNode, node.name);
    attachLibraryComponentDesc(astNode, node, libraryComponentType, componentsMap);
    const style = extractNodeStyle(node);
    if (style) {
        astNode.style = style;
    }
    if (node.type === 'TEXT') {
        const textRuns = extractMixedTextRuns(node);
        if (textRuns) {
            astNode.textRuns = textRuns;
            stripTextTypographyForMixedRuns(astNode.style);
        }
    }
    // 如果是背景图节点且有 asset，在 style 中添加标记，确保使用 backgroundImage
    if (asset && isBackgroundNode$1(node) && baseType === 'image') {
        if (!astNode.style) {
            astNode.style = {};
        }
        // 添加标记，让 prompt 知道这是背景图，应该使用 backgroundImage
        astNode.style.isBackground = true;
    }
    const layout = extractLayout(node);
    if (layout) {
        astNode.layout = layout;
        // 优化 type：如果是 container 且是 flex 布局，根据 direction 细化为 Row/Column
        if (astNode.type === 'container' && layout.display === 'flex' && outputType === 'container') {
            if (layout.direction === 'row') {
                astNode.type = 'Row';
            }
            else if (layout.direction === 'column') {
                astNode.type = 'Column';
            }
        }
    }
    // 按钮：不输出固定 width（Figma 外框宽 + padding + border 在默认 content-box 下易挤没内文；生码走 hug/minWidth + boxSizing 等）
    if (baseType === 'button' && astNode.style?.width !== undefined) {
        delete astNode.style.width;
    }
    // 处理子节点
    let children;
    if (Array.isArray(node.children) && node.children.length > 0) {
        const processedChildren = [];
        let hasAbsoluteChild = false;
        // 如果父节点是 auto-layout，而子节点没有明确的绝对定位约束，不要将其设为 absolute
        // 只有当子节点明确是 "RIGHT/TOP", "LEFT/BOTTOM" 等非默认约束时才考虑
        const isParentAutoLayout = node.layoutMode && node.layoutMode !== 'NONE';
        for (const child of node.children) {
            const processedChild = createCleanAst(child, imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
            if (processedChild) {
                let appliedAbsolutePosition = false;
                const isAbsoluteChildInAutoLayout = Boolean(isParentAutoLayout) &&
                    String(child?.layoutPositioning || '').toUpperCase() === 'ABSOLUTE';
                // 如果父节点不是 auto-layout (即 Frame/Group)，则必须使用 absolute positioning
                // 如果父节点是 auto-layout，通常子节点遵循 flow，不需要 absolute；
                // 但：如果子节点明确标记为 ABSOLUTE（layoutPositioning === 'ABSOLUTE'），必须保留/生成 absolute 定位。
                if (!isParentAutoLayout || isAbsoluteChildInAutoLayout) {
                    if (applyAbsolutePositionFromConstraints(node, child, processedChild)) {
                        appliedAbsolutePosition = true;
                    }
                    else if (processedChild.style && typeof processedChild.style.x === 'number' && typeof processedChild.style.y === 'number') {
                        // Fallback: 如果没有 constraints 能够计算，但也需要相对定位 (因为 x/y 是全局坐标)
                        // 手动转为 top/left relative
                        const parentBox = node.absoluteBoundingBox;
                        if (parentBox) {
                            const px = Math.round(parentBox.x || 0);
                            const py = Math.round(parentBox.y || 0);
                            processedChild.style.position = 'absolute';
                            processedChild.style.left = Math.round(processedChild.style.x - px);
                            processedChild.style.top = Math.round(processedChild.style.y - py);
                            delete processedChild.style.x;
                            delete processedChild.style.y;
                            appliedAbsolutePosition = true;
                        }
                    }
                }
                stripRedundantAbsoluteOrigin(processedChild.style);
                if (appliedAbsolutePosition && processedChild.style?.position === 'absolute') {
                    hasAbsoluteChild = true;
                }
                // 清理样式
                if (processedChild.style) {
                    if (isParentAutoLayout) {
                        // Auto-layout 子节点：默认移除所有定位属性，完全依赖 Flex 布局；
                        // 但如果它明确是 ABSOLUTE 子节点，则保留我们生成的 absolute 定位。
                        if (!isAbsoluteChildInAutoLayout && processedChild.style.position !== 'absolute') {
                            delete processedChild.style.position;
                            delete processedChild.style.top;
                            delete processedChild.style.left;
                            delete processedChild.style.right;
                            delete processedChild.style.bottom;
                            delete processedChild.style.x;
                            delete processedChild.style.y;
                        }
                        else {
                            // 绝对定位子节点不需要 x/y（全局坐标），避免混淆
                            if (processedChild.style.x !== undefined)
                                delete processedChild.style.x;
                            if (processedChild.style.y !== undefined)
                                delete processedChild.style.y;
                        }
                    }
                    else {
                        // 非 auto-layout (Frame)，如果不 absolute，x/y 是全局的，没用
                        // 上面的 fallback 应该已经处理了大部分情况
                        // 如果还剩 x/y，就删掉吧，避免混淆
                        if (processedChild.style.x !== undefined)
                            delete processedChild.style.x;
                        if (processedChild.style.y !== undefined)
                            delete processedChild.style.y;
                    }
                }
                processedChildren.push(processedChild);
                // 如果处理的是 input/textarea 节点，检查它的原始 children 中是否有"提示"节点
                // 如果有，将它们也处理并作为兄弟节点添加
                const processedChildBaseType = processedChild.__baseType ?? processedChild.type;
                if ((processedChildBaseType === 'input' || processedChildBaseType === 'textarea') &&
                    Array.isArray(child.children) && child.children.length > 0) {
                    const hintNodes = child.children
                        .filter((hintChild) => hintChild && hintChild.name === '提示')
                        .map((hintChild) => createCleanAst(hintChild, imageRefMap, imagePaths, child, imageMeta, wholeImageLayerNames, componentsMap))
                        .filter((hintNode) => Boolean(hintNode));
                    if (hintNodes.length > 0) {
                        processedChildren.push(...hintNodes);
                    }
                }
            }
        }
        if (processedChildren.length > 0) {
            children = processedChildren;
        }
        // 如果有 absolute 子节点，父节点需要 relative 作为定位参照
        if (hasAbsoluteChild) {
            if (!astNode.style)
                astNode.style = {};
            if (!astNode.style.position) {
                astNode.style.position = 'relative';
            }
        }
    }
    // 自动布局兼容处理
    if (isAutoLayoutNode(node) && hasImageFillBackground(node) && children && children.length > 0) {
        // 使用自动布局专用创建逻辑：图片作为背景，子节点正常处理
        const autoLayoutNode = createAutoLayoutAstNode(node, asset, baseType, astNode.style, children);
        autoLayoutNode.type = (libraryComponentType ?? uiAliasType ?? baseType);
        attachBaseType(autoLayoutNode, baseType);
        attachFigmaName(autoLayoutNode, node.name);
        attachLibraryComponentDesc(autoLayoutNode, node, libraryComponentType, componentsMap);
        processModalLikeChildrenByMarkers(autoLayoutNode);
        stripStyleLayoutIfComponentType(autoLayoutNode);
        return autoLayoutNode;
    }
    if (asset) {
        astNode.asset = {
            index: asset.index,
            path: asset.path,
            mode: asset.mode,
            transform: asset.transform,
            width: asset.width,
            height: asset.height,
        };
    }
    if (node.type === 'TEXT' &&
        typeof node.characters === 'string' &&
        node.characters.length > 0 &&
        (!Array.isArray(astNode.textRuns) || astNode.textRuns.length === 0)) {
        astNode.text = node.characters;
    }
    // 原有逻辑：如果有 asset 且是 fill 类型，或者没有 asset，才处理子节点
    if ((!asset || asset.source === 'fill') && children && children.length > 0) {
        astNode.children = children;
    }
    // 仅命中组件库 UIInput、且未走表单分支时：仍解析「前缀/后缀」槽（与 input 表单逻辑一致）
    if (libraryComponentType === 'UIInput' &&
        !node._formControlType &&
        !astNode.prefixAsset &&
        !astNode.prefixSlotAst &&
        !astNode.suffixAsset &&
        !astNode.suffixSlotAst) {
        const prefixSlot = findPrefixSuffixSlot(node, 'prefix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
        const suffixSlot = findPrefixSuffixSlot(node, 'suffix', imageRefMap, imagePaths, node, imageMeta, wholeImageLayerNames, componentsMap);
        attachPrefixSuffixFromSlots(astNode, prefixSlot, suffixSlot, node, imageRefMap, imagePaths, imageMeta, wholeImageLayerNames, componentsMap);
    }
    processModalLikeChildrenByMarkers(astNode);
    stripStyleLayoutIfComponentType(astNode);
    return astNode;
}
function isIconLikeAstType(t) {
    return t === 'icon' || t === 'iconfont' || t === 'image';
}
/**
 * 深度优先：在「前缀/后缀」子树中寻找第一个 icon / iconfont / image AST。
 * 设计组件里常见 Search 图标 INSTANCE + VECTOR，未必有 instance_ 位图导出。
 */
function findFirstIconLikeAstInSubtree(figmaNode, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap, depth) {
    if (!figmaNode || typeof figmaNode !== 'object' || depth > 28)
        return undefined;
    if (figmaNode.type === 'TEXT')
        return undefined;
    const ast = createCleanAst(figmaNode, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap);
    if (ast && isIconLikeAstType(String(ast.type))) {
        return ast;
    }
    if (Array.isArray(figmaNode.children)) {
        for (const child of figmaNode.children) {
            const got = findFirstIconLikeAstInSubtree(child, imageRefMap, imagePaths, figmaNode, imageMeta, wholeImageLayerNames, componentsMap, depth + 1);
            if (got)
                return got;
        }
    }
    return undefined;
}
function findPrefixSuffixSlot(root, slot, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap) {
    const keywords = slot === 'prefix' ? INPUT_PREFIX_SLOT_KEYWORDS : INPUT_SUFFIX_SLOT_KEYWORDS;
    const stack = [{ node: root, inSlot: false }];
    while (stack.length > 0) {
        const { node: cur, inSlot } = stack.pop();
        if (!cur || typeof cur !== 'object')
            continue;
        const name = typeof cur.name === 'string' ? cur.name.toLowerCase() : '';
        const nextInSlot = inSlot || (name && keywords.some((k) => name.includes(k)));
        if (nextInSlot) {
            const asset = resolveNodeAsset(cur, imageRefMap, imagePaths, imageMeta);
            if (asset && asset.source && asset.source !== 'fill') {
                return { node: cur, asset };
            }
            const slotAst = findFirstIconLikeAstInSubtree(cur, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap, 0);
            if (slotAst) {
                return { node: cur, slotAst };
            }
        }
        if (Array.isArray(cur.children)) {
            for (const child of cur.children) {
                stack.push({ node: child, inSlot: nextInSlot });
            }
        }
    }
    return undefined;
}
function attachPrefixSuffixFromSlots(astNode, prefixSlot, suffixSlot, scopeParent, imageRefMap, imagePaths, imageMeta, wholeImageLayerNames, componentsMap) {
    if (prefixSlot?.asset) {
        let prefixStyle;
        let prefixLayout;
        if (prefixSlot.node) {
            const prefixAstNode = createCleanAst(prefixSlot.node, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap);
            if (prefixAstNode) {
                prefixStyle = prefixAstNode.style;
                prefixLayout = prefixAstNode.layout;
            }
        }
        astNode.prefixAsset = {
            index: prefixSlot.asset.index,
            path: prefixSlot.asset.path,
            mode: prefixSlot.asset.mode,
            transform: prefixSlot.asset.transform,
            style: prefixStyle,
            layout: prefixLayout,
        };
    }
    else if (prefixSlot?.slotAst) {
        astNode.prefixSlotAst = prefixSlot.slotAst;
    }
    if (suffixSlot?.asset) {
        let suffixStyle;
        let suffixLayout;
        if (suffixSlot.node) {
            const suffixAstNode = createCleanAst(suffixSlot.node, imageRefMap, imagePaths, scopeParent, imageMeta, wholeImageLayerNames, componentsMap);
            if (suffixAstNode) {
                suffixStyle = suffixAstNode.style;
                suffixLayout = suffixAstNode.layout;
            }
        }
        astNode.suffixAsset = {
            index: suffixSlot.asset.index,
            path: suffixSlot.asset.path,
            mode: suffixSlot.asset.mode,
            transform: suffixSlot.asset.transform,
            style: suffixStyle,
            layout: suffixLayout,
        };
    }
    else if (suffixSlot?.slotAst) {
        astNode.suffixSlotAst = suffixSlot.slotAst;
    }
}

/**
 * 主入口：处理 Figma 数据
 */
/**
 * 生成数据模式说明
 */
function generateSchema() {
    return {
        assets: 'asset path array（与 ast.asset.index 对应）',
        ast: 'Clean AST tree (type/layout/style/text/asset/children)'
    };
}
/**
 * 处理 Figma 数据
 */
async function processFigmaData(rawData, token, fileKey, options) {
    const skipOSSUpload = options?.skipOSSUpload ?? true;
    const ossConfig = options?.ossConfig;
    const wholeImageLayerNames = options?.wholeImageLayerNames;
    const nodes = rawData?.nodes || {};
    const firstNodeKey = Object.keys(nodes)[0];
    if (!firstNodeKey) {
        throw new Error('未找到节点数据');
    }
    const nodeBundle = nodes[firstNodeKey];
    const document = nodeBundle?.document;
    if (!document) {
        throw new Error('未找到文档节点');
    }
    const componentsMap = nodeBundle?.components;
    const cleanedNode = pruneNode(document, NODE_FIELD_WHITELIST);
    if (!cleanedNode) {
        throw new Error('根节点不可见或无效');
    }
    resetProcessedGenerationState();
    const { imageRefMap, imagePaths, imageMeta } = await extractAndDownloadImages(cleanedNode, token, fileKey, ossConfig, skipOSSUpload, wholeImageLayerNames);
    const ast = createCleanAst(cleanedNode, imageRefMap, imagePaths, undefined, imageMeta, wholeImageLayerNames, componentsMap) ?? {
        type: 'container',
        id: makeFigmaAstId(cleanedNode),
    };
    const requiredMark = getRequiredMarkForProcessed();
    return {
        _: generateSchema(),
        assets: imagePaths,
        ast,
        requiredMark,
    };
}

/**
 * 过滤工具函数
 */
/**
 * 检查节点名称是否包含背景图关键词
 */
function isBackgroundNode(node) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase();
    const backgroundKeywords = ['bg', 'background', '背景', '背景图'];
    return backgroundKeywords.some(keyword => name.includes(keyword));
}
/**
 * 是否包含文本子节点（用于避免把带文字的小容器当成图标）
 */
function hasTextDescendant(node) {
    if (!node || typeof node !== 'object')
        return false;
    if (node.type === 'TEXT') {
        return true;
    }
    if (Array.isArray(node.children)) {
        return node.children.some((child) => hasTextDescendant(child));
    }
    return false;
}
/**
 * 判断一个节点是否是"图标容器"（小尺寸、单一图形/实例、无文本）
 * 或者节点会有 asset（会被提取为图片/图标）
 * 只用结构和尺寸来判断，不依赖中文命名
 */
function isIconContainer(node) {
    if (!node || typeof node !== 'object')
        return false;
    // 原有的图标容器判断逻辑
    const bbox = node.absoluteBoundingBox;
    if (!bbox || typeof bbox.width !== 'number' || typeof bbox.height !== 'number') {
        return false;
    }
    const width = Math.abs(bbox.width);
    const height = Math.abs(bbox.height);
    // 小方块 / 接近方块，典型图标尺寸
    if (width < 8 || height < 8 || width > 64 || height > 64) {
        return false;
    }
    const ratio = width && height ? Math.max(width, height) / Math.min(width, height) : 1;
    if (ratio > 1.2) {
        // 太长条的不算图标
        return false;
    }
    // 避免带文字的小卡片
    if (hasTextDescendant(node)) {
        return false;
    }
    // 只看容器直接子节点，用结构来判断
    if (!Array.isArray(node.children) || node.children.length === 0) {
        return false;
    }
    const child = node.children[0];
    const childType = child?.type;
    const isVectorLike = childType === 'VECTOR' ||
        childType === 'ELLIPSE' ||
        childType === 'POLYGON' ||
        childType === 'STAR' ||
        childType === 'RECTANGLE';
    const hasImageFill = Array.isArray(child?.fills) &&
        child.fills.some((fill) => fill && fill.type === 'IMAGE' && fill.visible !== false);
    const isInstanceLike = childType === 'INSTANCE' || childType === 'COMPONENT';
    // 单个矢量/图片/实例，基本可以认为是图标容器
    if (node.children.length === 1 && (isVectorLike || hasImageFill || isInstanceLike)) {
        return true;
    }
    return false;
}
/**
 * 检查节点是否是装饰性背景图（应该被删除）
 * 条件：
 * 1. 节点是 RECTANGLE/ELLIPSE 类型
 * 2. 填充了图片（fills 中有 IMAGE 类型）
 * 3. 透明度低（opacity < 0.5）
 * 4. 有模糊（effects 中有 LAYER_BLUR 或 BACKGROUND_BLUR）
 * 5. 没有交互（interactions 为空或不存在）
 * 6. 名字像背景（包含 bg / blur / mask / shadow）
 */
function isDecorativeBackground(node) {
    if (!node || (node.type !== 'RECTANGLE' && node.type !== 'ELLIPSE')) {
        return false;
    }
    // 检查是否有图片填充
    const hasImageFill = Array.isArray(node.fills) &&
        node.fills.some((fill) => fill?.type === 'IMAGE' && fill.visible !== false);
    if (!hasImageFill) {
        return false;
    }
    // 检查透明度（检查 fills 中的 opacity 或节点本身的 opacity）
    const fillOpacity = Array.isArray(node.fills)
        ? node.fills.find((fill) => fill?.type === 'IMAGE')?.opacity
        : undefined;
    const nodeOpacity = node.opacity;
    const opacity = fillOpacity !== undefined ? fillOpacity : (nodeOpacity !== undefined ? nodeOpacity : 1);
    if (opacity >= 0.5) {
        return false;
    }
    // 检查是否有模糊效果
    const hasBlur = Array.isArray(node.effects) &&
        node.effects.some((effect) => effect?.visible !== false &&
            (effect?.type === 'LAYER_BLUR' || effect?.type === 'BACKGROUND_BLUR'));
    if (!hasBlur) {
        return false;
    }
    // 检查是否有交互
    const hasInteractions = Array.isArray(node.interactions) && node.interactions.length > 0;
    if (hasInteractions) {
        return false;
    }
    // 如果满足前5个条件（RECTANGLE/ELLIPSE + 图片填充 + 低透明度 + 模糊 + 无交互），
    // 即使名字不包含关键词，也认为是装饰性背景图
    return true;
}
/**
 * 检查一个叶子节点是否是视觉上"空"的（没有可见的填充或描边）
 */
function isVisuallyEmpty(node) {
    if (!node)
        return true;
    // 只检查叶子节点类型
    const visualTypes = ['VECTOR', 'ELLIPSE', 'RECTANGLE', 'STAR', 'POLYGON', 'LINE', 'REGULAR_POLYGON'];
    if (!visualTypes.includes(node.type)) {
        return false;
    }
    // 检查是否有可见的填充
    const hasVisibleFills = Array.isArray(node.fills) && node.fills.some((fill) => fill && fill.visible !== false && (fill.opacity === undefined || fill.opacity > 0));
    // 检查是否有可见的描边
    const hasVisibleStrokes = Array.isArray(node.strokes) && node.strokes.length > 0 && node.strokes.some((stroke) => stroke && stroke.visible !== false && (stroke.opacity === undefined || stroke.opacity > 0)) && (node.strokeWeight === undefined || node.strokeWeight > 0);
    // 如果没有可见的填充也没有可见的描边，则视为视觉空
    if (!hasVisibleFills && !hasVisibleStrokes) {
        // 特殊情况：图片填充可能被视为无填充（如果 fills 被过滤了）
        // 但这里我们是在 filters 之前检查，或者 filters 之后
        // 假设 fills 已经被 filters 处理过了，如果为空数组，就是无填充
        return true;
    }
    return false;
}

/**
 * 过滤 Figma 数据
 */
const COMPONENT_NAME_SET = new Set(Object.keys(components));
function isMarkedAsUIModal(node) {
    const raw = typeof node?.name === 'string' ? node.name : '';
    if (!raw)
        return false;
    return raw.includes('UIModal') || raw.includes('#UIModal');
}
function isTopRightConstraintNode(node) {
    const c = node?.constraints;
    const h = typeof c?.horizontal === 'string' ? c.horizontal.toUpperCase() : '';
    const v = typeof c?.vertical === 'string' ? c.vertical.toUpperCase() : '';
    return h === 'RIGHT' && v === 'TOP';
}
function isSmallBBox(node, max) {
    const bbox = node?.absoluteBoundingBox;
    if (!bbox)
        return false;
    const w = Math.abs(bbox.width || 0);
    const h = Math.abs(bbox.height || 0);
    return w > 0 && h > 0 && w <= max && h <= max;
}
function hasVectorDescendant(node) {
    if (!node || typeof node !== 'object')
        return false;
    const t = String(node.type || '');
    if (t === 'VECTOR' || t === 'ELLIPSE' || t === 'POLYGON' || t === 'STAR' || t === 'LINE')
        return true;
    if (Array.isArray(node.children)) {
        return node.children.some((c) => hasVectorDescendant(c));
    }
    return false;
}
/**
 * 仅对明确标识为 UIModal 的节点做 close（X）容器删除：
 * - 只删除“唯一一个”右上角 RIGHT/TOP + 小尺寸(<=48) + 含矢量的直系子节点
 * - 候选不唯一时不处理，避免误删其他右上角图标/按钮
 */
function removeModalCloseContainerIfPresent(filteredNode, originalNode) {
    if (!filteredNode || !originalNode)
        return;
    if (!isMarkedAsUIModal(originalNode))
        return;
    if (!Array.isArray(filteredNode.children) || filteredNode.children.length === 0)
        return;
    const candidates = filteredNode.children.filter((child) => {
        if (!child)
            return false;
        if (!isTopRightConstraintNode(child))
            return false;
        if (!isSmallBBox(child, 48))
            return false;
        return hasVectorDescendant(child);
    });
    if (candidates.length === 1) {
        const target = candidates[0];
        filteredNode.children = filteredNode.children.filter((c) => c !== target);
    }
}
function resolveLibraryComponentTypeFromAllNodes(node, allNodes) {
    if (!node || typeof node !== 'object')
        return undefined;
    // 兼容两种场景：
    // - INSTANCE：使用 node.componentId 查 components/componentSets
    // - COMPONENT（组件定义/变体本身）：使用 node.id 查 components/componentSets
    // 这样在“直接选中组件变体节点”时也能命中组件库类型（例如：选项卡分段#UITabs）
    const isInstance = node.type === 'INSTANCE';
    const isComponent = node.type === 'COMPONENT';
    if (!isInstance && !isComponent)
        return undefined;
    const componentKey = isInstance ? node.componentId : node.id;
    if (typeof componentKey !== 'string' || !componentKey)
        return undefined;
    const def = allNodes?.components?.[componentKey];
    // 1) 优先用 component 定义的 name（有些库会直接包含 #UIButton/#UIModal 等）
    const rawName = typeof def?.name === 'string' ? def.name.trim() : '';
    if (rawName) {
        const candidate = rawName.includes('#') ? rawName.split('#').pop().trim() : rawName;
        if (candidate && COMPONENT_NAME_SET.has(candidate)) {
            return candidate;
        }
    }
    // 2) 如果 component name 是变体描述（如“类型=.../状态=...”），则用 componentSetId 反查 componentSets.name
    // 这样可以稳定拿到 “按钮#UIButton / 模态窗#UIModal / 文本输入#UIInput ...”
    const componentSetId = typeof def?.componentSetId === 'string' ? def.componentSetId : '';
    if (componentSetId) {
        const setDef = allNodes?.componentSets?.[componentSetId];
        const setName = typeof setDef?.name === 'string' ? setDef.name.trim() : '';
        if (setName) {
            const candidate = setName.includes('#') ? setName.split('#').pop().trim() : setName;
            if (candidate && COMPONENT_NAME_SET.has(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
/**
 * 从 Figma nodes 响应里的 `components` 表取当前实例/组件变体的 `name`（常为「类型=…, 规格=…」）。
 */
function resolveComponentDescFromAllNodes(node, allNodes) {
    if (!node || typeof node !== 'object')
        return undefined;
    const isInstance = node.type === 'INSTANCE';
    const isComponent = node.type === 'COMPONENT';
    if (!isInstance && !isComponent)
        return undefined;
    const componentKey = isInstance ? node.componentId : node.id;
    if (typeof componentKey !== 'string' || !componentKey)
        return undefined;
    const def = allNodes?.components?.[componentKey];
    const raw = typeof def?.name === 'string' ? def.name.trim() : '';
    return raw || undefined;
}
/**
 * 检查节点名称是否匹配关键词
 */
function matchesNodeName(node, keywords) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase();
    return keywords.some(keyword => name.includes(keyword.toLowerCase()));
}
/**
 * 识别表单控件类型
 */
function detectFormControlType(node) {
    if (!node || !node.name)
        return null;
    const inputKeywords = ['input', '文本输入', '输入框', '文本框', 'textfield', 'text field'];
    if (matchesNodeName(node, inputKeywords)) {
        return 'input';
    }
    const checkboxKeywords = ['checkbox', '复选框', 'check box', '勾选', '选择框'];
    if (matchesNodeName(node, checkboxKeywords)) {
        return 'checkbox';
    }
    const radioKeywords = ['radio', '单选', 'radio button', '单选按钮'];
    if (matchesNodeName(node, radioKeywords)) {
        return 'radio';
    }
    // 检查是否是导航链接（导航链接即使包含 dropdown 也不应该是 select）
    const navKeywords = ['nav', 'link', '导航', '菜单', 'menu'];
    const isNavLink = matchesNodeName(node, navKeywords);
    const selectKeywords = ['select', '选择器', 'drop-down', 'dropdown', '下拉框', '下拉菜单'];
    if (!isNavLink && matchesNodeName(node, selectKeywords)) {
        return 'select';
    }
    const switchKeywords = ['switch', 'toggle', '开关', '切换'];
    if (matchesNodeName(node, switchKeywords)) {
        return 'switch';
    }
    const textareaKeywords = ['textarea', '文本域', '多行输入', 'text area', 'text-area', '多行文本框', '多行文本输入'];
    if (matchesNodeName(node, textareaKeywords)) {
        return 'textarea';
    }
    const tableKeywords = ['table', '表格'];
    if (matchesNodeName(node, tableKeywords)) {
        return 'table';
    }
    return null;
}
/**
 * 判断节点是否是前缀或后缀图标
 */
function isPrefixSuffixIcon(node) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase();
    // 只匹配明确的前后缀容器命名，避免误把普通 icon 节点当成前后缀
    const keywords = ['prefix', 'suffix', 'leading', 'trailing', '前缀', '后缀', '附加', '左侧', '右侧'];
    return keywords.some((keyword) => keyword && name.includes(keyword));
}
/**
 * 判断节点是否是文本节点
 */
function isTextNode(node) {
    return node && node.type === 'TEXT' && typeof node.characters === 'string' && node.characters.trim().length > 0;
}
function isHelpTextNode(node) {
    if (!isTextNode(node))
        return false;
    const text = String(node.characters || '').trim();
    const name = String(node.name || '').trim();
    // 仅过滤明确的“帮助提示”文案，避免误伤正常说明文案
    return text === '帮助提示' || name === '帮助提示' || name.includes('帮助提示');
}
function getTextFillOpacity(node) {
    if (!node || !Array.isArray(node.fills))
        return undefined;
    const solid = node.fills.find((f) => f && f.type === 'SOLID' && f.visible !== false);
    const opacity = solid?.opacity;
    return typeof opacity === 'number' ? opacity : undefined;
}
function isPlaceholderTextNode(node) {
    if (!isTextNode(node))
        return false;
    const nodeName = (node.name || '').toLowerCase();
    // 设计组件里 placeholder 常用 Value/Placeholder 命名，且文字颜色透明度较低
    const nameHint = nodeName === 'value' || nodeName.includes('placeholder') || nodeName.includes('占位');
    const opacity = getTextFillOpacity(node);
    const opacityHint = typeof opacity === 'number' ? opacity <= 0.6 : false;
    return nameHint || opacityHint;
}
/**
 * 递归查找所有文本节点
 */
function findAllTextNodes(node) {
    const textNodes = [];
    if (!node)
        return textNodes;
    if (isTextNode(node)) {
        textNodes.push(node);
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            textNodes.push(...findAllTextNodes(child));
        }
    }
    return textNodes;
}
/**
 * 递归查找所有文本节点，并记录其父容器路径
 */
function findAllTextNodesWithPath(node, parentPath = []) {
    const textNodes = [];
    if (!node)
        return textNodes;
    if (isTextNode(node)) {
        textNodes.push({ node, path: parentPath });
    }
    if (Array.isArray(node.children)) {
        const currentPath = node.name ? [...parentPath, node.name] : parentPath;
        for (const child of node.children) {
            textNodes.push(...findAllTextNodesWithPath(child, currentPath));
        }
    }
    return textNodes;
}
/**
 * 处理表单控件节点：移除视觉样式，保留文案和前后缀图标
 */
function processFormControlNode(node, formControlType, allNodes) {
    const processed = {
        ...node,
        _formControlType: formControlType,
    };
    // 移除所有视觉样式
    delete processed.fills;
    delete processed.strokes;
    delete processed.strokeWeight;
    delete processed.strokeAlign;
    delete processed.strokeCap;
    delete processed.strokeJoin;
    delete processed.strokeDashes;
    delete processed.dashPattern;
    delete processed.effects;
    delete processed.background;
    delete processed.backgroundColor;
    delete processed.opacity;
    delete processed.blendMode;
    // 保留宽高信息（absoluteBoundingBox 已经在 node 中，不需要额外处理）
    // 处理子节点：只保留文案和前后缀图标
    // 先递归查找所有文本节点（即使被 filterNode 过滤掉了也要保留）
    const allTextNodes = findAllTextNodes(node).filter((n) => n && n.visible !== false && !isHelpTextNode(n));
    const allTextNodesWithPath = findAllTextNodesWithPath(node).filter((item) => item.node && item.node.visible !== false && !isHelpTextNode(item.node));
    // table: 移除所有子节点（不提取内容），也不保留样式
    if (formControlType === 'table') {
        delete processed.children;
        return processed;
    }
    // select: 移除所有子节点（包括箭头图标），不提取任何图片/图标，但保留 placeholder（如果有）
    if (formControlType === 'select') {
        // 提取 placeholder（如果有）
        if (allTextNodesWithPath.length > 0) {
            const placeholderItem = allTextNodesWithPath.find((item) => {
                const path = item.path.map((p) => p.toLowerCase());
                return !path.includes('提示') && !path.includes('hint') && !path.includes('help');
            });
            if (placeholderItem && placeholderItem.node && typeof placeholderItem.node.characters === 'string') {
                processed._placeholder = placeholderItem.node.characters;
            }
        }
        // 移除所有子节点，不保留任何图标或样式
        delete processed.children;
        return processed;
    }
    // input/textarea：提取 placeholder 文案（不要作为 children）
    if ((formControlType === 'input' || formControlType === 'textarea') && allTextNodesWithPath.length > 0) {
        // 优先选择在"输入框"或"字段"容器内的文本节点作为placeholder
        const inputFieldNode = allTextNodesWithPath.find((item) => {
            const path = item.path.map((p) => p.toLowerCase());
            return path.includes('输入框') || path.includes('字段') || path.includes('input') || path.includes('field');
        });
        // 如果找到了输入框/字段内的文本，使用它
        let placeholderItem = inputFieldNode;
        // 如果没找到，尝试找不在"提示"容器内的文本节点
        if (!placeholderItem) {
            placeholderItem = allTextNodesWithPath.find((item) => {
                const path = item.path.map((p) => p.toLowerCase());
                return !path.includes('提示') && !path.includes('hint') && !path.includes('help');
            });
        }
        // 如果还是没找到，使用isPlaceholderTextNode判断（但排除"提示"容器内的）
        if (!placeholderItem) {
            placeholderItem = allTextNodesWithPath.find((item) => {
                const path = item.path.map((p) => p.toLowerCase());
                return !path.includes('提示') && !path.includes('hint') && !path.includes('help') && isPlaceholderTextNode(item.node);
            });
        }
        // 最后的选择：使用第一个不在"提示"容器内的文本节点
        if (!placeholderItem) {
            placeholderItem = allTextNodesWithPath.find((item) => {
                const path = item.path.map((p) => p.toLowerCase());
                return !path.includes('提示') && !path.includes('hint') && !path.includes('help');
            });
        }
        if (placeholderItem && placeholderItem.node && typeof placeholderItem.node.characters === 'string') {
            processed._placeholder = placeholderItem.node.characters;
        }
    }
    if (Array.isArray(node.children)) {
        const filteredChildren = [];
        // checkbox/radio/switch：只保留 label 文案（排除帮助提示；input 的 placeholder 也不作为 children）
        if (formControlType === 'checkbox' || formControlType === 'radio' || formControlType === 'switch') {
            for (const textNode of allTextNodes) {
                if (isPlaceholderTextNode(textNode))
                    continue;
                filteredChildren.push(textNode);
            }
        }
        for (const child of node.children) {
            if (!child || child.visible === false)
                continue;
            // input/textarea：不保留任何文本 children（placeholder 已提取到 _placeholder）
            if ((formControlType === 'input' || formControlType === 'textarea') && isTextNode(child)) {
                continue;
            }
            // 仅 input/textarea 保留前后缀图标相关结构（用于后续提取 prefix/suffix icon）
            const shouldKeepIconStructure = formControlType === 'input' || formControlType === 'textarea';
            const processChildSafe = (c) => {
                if (!c || c.visible === false)
                    return null;
                // 如果是文本节点，且在 input/textarea 中，应该在前面被 filteredChildren 逻辑处理过了
                // 但这里是针对图标结构的递归
                const result = { ...c };
                // 移除一些不必要的样式，保持图标结构的精简
                // 但保留 fills 等信息，因为可能是矢量图标
                if (Array.isArray(c.children)) {
                    result.children = c.children.map(processChildSafe).filter(Boolean);
                }
                return result;
            };
            if (shouldKeepIconStructure && isPrefixSuffixIcon(child)) {
                // 递归处理子节点，但保留图标本身
                const processedChild = processChildSafe(child);
                if (processedChild) {
                    filteredChildren.push(processedChild);
                }
                continue;
            }
            // 递归查找前后缀容器（可能嵌套在其他容器中）
            // 这里同样不能直接调用 filterNode，因为如果 child 内部包含 form control 可能会有问题
            // 但主要是为了查找 prefix/suffix，所以我们可以只关注结构
            const processedChild = processChildSafe(child);
            if (processedChild) {
                const hasPrefixSuffix = isPrefixSuffixIcon(processedChild) ||
                    (Array.isArray(processedChild.children) &&
                        processedChild.children.some((c) => isPrefixSuffixIcon(c)));
                if (shouldKeepIconStructure && hasPrefixSuffix) {
                    filteredChildren.push(processedChild);
                }
                else if ((formControlType === 'input' || formControlType === 'textarea') && processedChild.name === '提示') {
                    // 对于 "提示" 节点，即使不是前后缀图标，也应该保留（作为输入框下方的提示信息）
                    filteredChildren.push(processedChild);
                }
            }
        }
        if (filteredChildren.length > 0) {
            processed.children = filteredChildren;
        }
        else {
            delete processed.children;
        }
    }
    else if (allTextNodes.length > 0) {
        // 如果没有 children 数组，但找到了文本节点，也要添加
        processed.children = allTextNodes.filter((n) => n && n.visible !== false);
    }
    return processed;
}
/**
 * 递归过滤节点，移除所有 visible 为 false 的节点及其所有子节点
 */
function filterNode(node, allNodes) {
    if (!node || node.visible === false) {
        return null;
    }
    // 过滤明确的“帮助提示”文案节点
    if (node.type === 'TEXT' && typeof node.characters === 'string' && node.characters.trim() === '帮助提示') {
        return null;
    }
    // 如果节点是 mask（isMask: true），删除该节点及其所有子节点
    if (node.isMask === true) {
        return null;
    }
    // 如果是装饰性背景图，删除该节点及其所有子节点
    if (isDecorativeBackground(node)) {
        return null;
    }
    const libraryComponentType = resolveLibraryComponentTypeFromAllNodes(node, allNodes);
    const componentDesc = libraryComponentType ? resolveComponentDescFromAllNodes(node, allNodes) : undefined;
    // 先检查是否是表单控件，如果是则特殊处理
    const formControlType = detectFormControlType(node);
    if (formControlType) {
        const processed = processFormControlNode(node, formControlType);
        if (libraryComponentType) {
            processed._libraryComponentType = libraryComponentType;
            if (componentDesc)
                processed._componentDesc = componentDesc;
        }
        return processed;
    }
    const filteredNode = { ...node };
    if (libraryComponentType) {
        filteredNode._libraryComponentType = libraryComponentType;
        if (componentDesc)
            filteredNode._componentDesc = componentDesc;
    }
    // 处理 fills 和 background 数组
    for (const field of ['fills', 'background']) {
        if (Array.isArray(node[field])) {
            const filtered = node[field].filter((item) => {
                if (!item || item.visible === false)
                    return false;
                // 4. 填充层透明度过滤：如果填充层透明度 <= 5%，视为不可见
                if (item.opacity !== undefined && item.opacity <= 0.05)
                    return false;
                return true;
            });
            if (filtered.length > 0) {
                filteredNode[field] = filtered;
            }
            else {
                delete filteredNode[field];
            }
        }
    }
    // 递归过滤子节点
    if (Array.isArray(node.children)) {
        // 避免无限递归：如果当前节点已经被处理为 form control，则不需要再递归处理 children
        // 因为 processFormControlNode 已经处理了 children
        // 这里的逻辑是针对普通节点的。
        // 如果 detectFormControlType 返回了类型，说明在上面的 if (formControlType) 分支已经处理过了并返回了。
        // 所以能走到这里说明不是 form control（或者被 detectFormControlType 漏掉了，但那是另一回事）。
        filteredNode.children = node.children
            .map((child) => filterNode(child, allNodes))
            .filter((child) => child !== null);
    }
    // 如果当前节点是 UIModal（明确标识），删除其右上角 close（X）容器（候选唯一才删）
    removeModalCloseContainerIfPresent(filteredNode, node);
    // 1. 透明度极低过滤：如果节点透明度 <= 5%，视为不可见
    if (filteredNode.opacity !== undefined && filteredNode.opacity <= 0.05) {
        return null;
    }
    // 2. 极小尺寸过滤：如果宽高都 < 0.5，且不是纯线条（排除 VECTOR/LINE），视为不可见杂质
    const bbox = filteredNode.absoluteBoundingBox;
    if (bbox && node.type !== 'LINE' && node.type !== 'VECTOR') {
        const w = Math.abs(bbox.width || 0);
        const h = Math.abs(bbox.height || 0);
        if (w < 0.5 && h < 0.5) {
            return null;
        }
    }
    // 3. 视觉空节点过滤：如果叶子节点没有可见的填充和描边，直接移除
    if (isVisuallyEmpty(filteredNode)) {
        return null;
    }
    // 如果结构上判断为图标容器或节点会有 asset，提前把 padding、borderRadius、borderWidth 类样式去掉
    // 这里只用尺寸/子节点结构判断，不使用任何中文关键字
    if (isIconContainer(node)) {
        delete filteredNode.paddingLeft;
        delete filteredNode.paddingRight;
        delete filteredNode.paddingTop;
        delete filteredNode.paddingBottom;
        delete filteredNode.strokes;
        delete filteredNode.strokeWeight;
        delete filteredNode.individualStrokeWeights;
        delete filteredNode.strokeAlign;
        delete filteredNode.strokeCap;
        delete filteredNode.strokeJoin;
        delete filteredNode.strokeDashes;
    }
    // 如果是背景图 FRAME 节点且有 children，将其转换为 GROUP 类型
    // 这样 processor 会将其作为 group_${id} 提取为一张图片
    if (node.type === 'FRAME' &&
        isBackgroundNode(node) &&
        Array.isArray(filteredNode.children) &&
        filteredNode.children.length > 0) {
        filteredNode.type = 'GROUP';
    }
    return filteredNode;
}
/**
 * 过滤 Figma 数据，移除所有 visible 为 false 的节点及其所有子节点
 */
// 递归过滤节点及其所有子节点，包括 overrides
function filterNodeRecursive(node, allNodes) {
    if (!node)
        return null;
    // 如果是简单的overrides引用（只有id，没有type），直接保留引用
    // 因为完整的节点应该已经在 children 中被处理了
    if (node.id && !node.type && !node.name) {
        return node;
    }
    const filtered = filterNode(node, allNodes);
    if (!filtered)
        return null;
    // 递归处理 children
    // 注意：filterNode 内部已经完全递归处理了 children，所以这里不需要再处理 children
    // 否则会导致无限递归
    // 处理 overrides（组件实例的变体数据）
    if (Array.isArray(filtered.overrides)) {
        filtered.overrides = filtered.overrides
            .map((override) => filterNodeRecursive(override, allNodes))
            .filter((override) => override !== null);
    }
    return filtered;
}
function filterFigmaData(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }
    if (data.nodes && typeof data.nodes === 'object') {
        const filteredNodes = {};
        for (const [nodeId, nodeData] of Object.entries(data.nodes)) {
            if (nodeData && typeof nodeData === 'object') {
                const nodeDataObj = nodeData;
                // 注意：Figma nodes 响应里 components/componentSets 通常挂在每个 nodeDataObj 下（而不是顶层 data）
                // 这里必须把 nodeDataObj 作为 allNodes 传入，才能正确解析 componentId -> components/componentSets.name
                const filteredDocument = nodeDataObj.document ? filterNodeRecursive(nodeDataObj.document, nodeDataObj) : null;
                if (filteredDocument !== null) {
                    filteredNodes[nodeId] = { ...nodeDataObj, document: filteredDocument };
                }
            }
        }
        return { ...data, nodes: filteredNodes };
    }
    return filterNodeRecursive(data, data);
}

/**
 * Web 端调用：从 Figma 设计稿生成 React 组件代码
 */
function isNodeRuntime() {
    // 浏览器环境下通常没有 process 或 process.versions.node
    return typeof process !== 'undefined' && Boolean(process?.versions?.node);
}
async function debugWriteJsonFile(filePath, data) {
    if (!isNodeRuntime())
        return;
    try {
        // 用 Function 包装动态 import，避免浏览器打包环境静态解析到 node 内置模块
        const dynamicImport = new Function('m', 'return import(m)');
        const mod = await dynamicImport('fs/promises');
        const writeFile = mod.writeFile;
        await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
    catch (err) {
        // 调试写文件失败不影响主流程
        console.warn(`保存调试数据失败(${filePath}):`, err);
    }
}
/**
 * 从 Figma URL 中提取 fileKey 和 nodeId
 * URL 格式: https://www.figma.com/design/{fileKey}/...?node-id={nodeId}&...
 */
/** 从 Figma 页面 URL 解析 fileKey 与 API 用 nodeId（冒号分隔） */
function parseFigmaUrl(url) {
    try {
        const urlObj = new URL(url);
        // 提取 fileKey: design/ 后面的第一个路径段
        const pathMatch = urlObj.pathname.match(/\/design\/([^\/]+)/);
        if (!pathMatch) {
            throw new Error('无法从 URL 中提取 fileKey，请确保 URL 格式正确');
        }
        const fileKey = pathMatch[1];
        // 提取 nodeId: node-id 查询参数
        const nodeIdParam = urlObj.searchParams.get('node-id');
        if (!nodeIdParam) {
            throw new Error('无法从 URL 中提取 node-id，请确保 URL 包含 node-id 参数');
        }
        // 将 node-id 格式从 "40004483-216243" 转换为 "40004483:216243"（Figma API 格式）
        const nodeId = nodeIdParam.replace(/-/g, ':');
        return { fileKey, nodeId };
    }
    catch (error) {
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('URL 解析失败，请确保提供有效的 Figma URL');
    }
}
/**
 * 拉取并处理 Figma 节点，返回含 ast、assets 的 processed 数据（默认 Figma 资源直链）
 */
async function getFigmaProcessedData(options) {
    try {
        const { token, url, ossConfig, skipOSSUpload, wholeImageLayerNames, debug } = options;
        const enableDebug = debug ?? true;
        const { fileKey, nodeId } = parseFigmaUrl(url);
        const rawData = await fetchFigmaNodes(token, nodeId, fileKey);
        if (enableDebug) {
            await debugWriteJsonFile('figma-node-2.json', rawData);
        }
        const filteredData = filterFigmaData(rawData);
        if (enableDebug) {
            await debugWriteJsonFile('figma-node-2-filtered.json', filteredData);
        }
        const processOpts = {
            ossConfig,
            skipOSSUpload: skipOSSUpload ?? true,
            wholeImageLayerNames,
        };
        const processedData = await processFigmaData(filteredData, token, fileKey, processOpts);
        if (enableDebug) {
            await debugWriteJsonFile('figma-node-2-press.json', processedData);
        }
        return processedData;
    }
    catch (error) {
        if (error instanceof Error && error.isTokenExpired) {
            throw new Error('Figma Token 已过期');
        }
        throw error;
    }
}

/**
 * Figma UI 本地脚本入口
 *
 * 不依赖 MCP，直接调用 figmaui 核心处理逻辑，把 Figma URL 转成含 ast、assets、requiredMark 的 JSON。
 * 输出默认走 stdout；提供 --out 时可写入文件。
 */
console.log = (...args) => {
    console.error(...args);
};
function printHelp() {
    console.log(`用法: node generate.mjs --url <Figma URL> [选项]

选项:
  --url     Figma 设计稿 URL，必须包含 node-id 参数
  --token   Figma API Token（可选；缺省时读取环境变量 FIGMA_PAT）
  --out     输出文件路径（可选；默认输出到 stdout）
  -h, --help  显示帮助

示例:
  node generate.mjs --url "https://www.figma.com/design/xxx/...?node-id=1-2"
  node generate.mjs --url "https://www.figma.com/design/xxx/...?node-id=1-2" --out figma-output.json
  FIGMA_PAT=xxxxx node generate.mjs --url "https://www.figma.com/design/xxx/...?node-id=1-2"`);
}
function parseCliArgs() {
    const { values } = parseArgs({
        options: {
            url: { type: 'string' },
            token: { type: 'string' },
            out: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        strict: true,
    });
    if (values.help) {
        printHelp();
        process.exit(0);
    }
    const url = values.url;
    if (typeof url !== 'string' || url.trim() === '') {
        console.error('[错误] 必须提供 --url 参数');
        printHelp();
        process.exit(1);
    }
    const tokenValue = values.token || process.env.FIGMA_PAT?.trim() || process.env.FIGMA_TOKEN?.trim();
    if (typeof tokenValue !== 'string' || tokenValue === '') {
        console.error('[错误] 缺少 Figma API Token。请提供 --token 参数或设置环境变量 FIGMA_PAT');
        printHelp();
        process.exit(1);
    }
    return { url, token: tokenValue, out: values.out };
}
async function main() {
    const { url, token, out } = parseCliArgs();
    const data = await getFigmaProcessedData({
        token,
        url,
        debug: false,
    });
    const json = JSON.stringify(data, null, 2);
    if (typeof out === 'string' && out.trim() !== '') {
        writeFileSync(out, json, 'utf-8');
        console.error(`已写入文件: ${out}`);
    }
    else {
        process.stdout.write(json);
    }
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[错误] ${message}`);
    process.exit(1);
});
