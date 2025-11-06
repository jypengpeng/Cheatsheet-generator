import React, { useState, useRef, useCallback, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// --- Constants ---
const A4_ASPECT_RATIO = 297 / 210;
const PAGE_WIDTH_PT = 595; // Standard A4 width in points (72dpi)
const PAGE_HEIGHT_PT = PAGE_WIDTH_PT * A4_ASPECT_RATIO;
const PAGE_PADDING_PT = 40; // 40pt padding
const COLUMN_GAP_PT = 10; // Space between columns (pt)

const MAX_FONT_SIZE = 16;
const MIN_FONT_SIZE = 2;
const FONT_STEP = 0.1;

const COLUMN_HEIGHT_PT = PAGE_HEIGHT_PT - (PAGE_PADDING_PT * 2);
const PT_TO_PX = 96 / 72; // CSS 1pt = 1/72in, 1px = 1/96in
const ptToPx = (pt: number) => pt * PT_TO_PX;

// px 派生尺寸：确保屏幕预览与打印一致（打印也按 96DPI 渲染 px）
const PAGE_WIDTH_PX = ptToPx(PAGE_WIDTH_PT);
const PAGE_HEIGHT_PX = ptToPx(PAGE_HEIGHT_PT);
const PAGE_PADDING_PX = ptToPx(PAGE_PADDING_PT);
const COLUMN_GAP_PX = ptToPx(COLUMN_GAP_PT);
const COLUMN_HEIGHT_PX = ptToPx(COLUMN_HEIGHT_PT);

// 高 DPI 导出参数
const EXPORT_DPI = 300; // 240~300 DPI 皆可，这里默认 300DPI
const EXPORT_IMAGE_QUALITY = 0.92; // JPEG 质量（0~1）

const DEFAULT_MARKDOWN = `# Markdown 页面适配器 (自动布局版)

这是一个智能排版工具，旨在帮助您将 Markdown 文本完美地排入两页 A4 纸中。

## 如何使用

1.  **输入内容**: 在编辑器中粘贴或输入您的 Markdown 文本。
2.  **点击排版**: 点击“智能排版”按钮。
3.  **预览结果**: 系统会自动寻找最佳布局（优先采用更多分栏，其次缩小字号），并在右侧预览区域展示结果。
4.  **微调字号**: 您可以使用预览上方的 +/- 按钮微调最终的字体大小。

## 功能特性

*   **自动字号调整**: 从 ${MAX_FONT_SIZE}pt 开始，逐步减小字号，直到内容适配。
*   **智能多栏布局**: 自动选择 1 到 4 栏的最佳布局以容纳内容。
*   **保留格式**: 支持所有标准的 Markdown 语法，如标题、列表、粗体、斜体等。
*   **打印友好**: 您可以直接使用浏览器的打印功能打印预览的页面。

---

> 如果文本内容过多，即使调整到最小字号（${MIN_FONT_SIZE}pt）和最密集的布局也无法容纳在两页内，系统会给出提示。

现在，请尝试粘贴您自己的内容！
`;


// --- SVG Icons ---
const SpinnerIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

const CheckCircleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
);

const ExclamationTriangleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
);


const App: React.FC = () => {
    const [markdown, setMarkdown] = useState<string>(DEFAULT_MARKDOWN);
    const [formattedHtml, setFormattedHtml] = useState<string>('');
    const [finalFontSize, setFinalFontSize] = useState<number | null>(null);
    const [finalNumColumns, setFinalNumColumns] = useState<number>(2);
    const [totalPages, setTotalPages] = useState<number>(2);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [columnOption, setColumnOption] = useState<'auto' | '1' | '2' | '3' | '4'>('auto');
    
    const measurementRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const calculatePages = async () => {
            if (!formattedHtml || !finalFontSize || !measurementRef.current) {
                if (!formattedHtml) {
                    setTotalPages(2); // Reset to default when no content
                }
                return;
            }

            const container = measurementRef.current;
            container.innerHTML = formattedHtml;
            const currentColumnWidthPt = (PAGE_WIDTH_PT - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (finalNumColumns - 1))) / finalNumColumns;
            const currentColumnWidthPx = ptToPx(currentColumnWidthPt);
            
            container.style.width = `${currentColumnWidthPx}px`;
            container.style.fontSize = `${finalFontSize}pt`;
            
            await new Promise(resolve => requestAnimationFrame(resolve)); // Let browser render

            const totalContentHeightPx = container.scrollHeight;
            const totalColumnsPerPage = finalNumColumns;
            const heightPerColumnPx = COLUMN_HEIGHT_PX;
            
            const totalColumnUnits = Math.ceil(totalContentHeightPx / heightPerColumnPx);
            const numPages = Math.ceil(totalColumnUnits / totalColumnsPerPage);

            setTotalPages(numPages > 0 ? numPages : 1);

            container.innerHTML = ''; // Clean up
        };

        calculatePages();
    }, [formattedHtml, finalFontSize, finalNumColumns]);


    const handleFormat = useCallback(async () => {
        setIsLoading(true);
        setFormattedHtml('');
        setFinalFontSize(null);
        setStatusMessage(null);

        await new Promise(resolve => setTimeout(resolve, 50));

        if (!measurementRef.current) {
            setStatusMessage({ type: 'error', text: '无法初始化排版引擎。' });
            setIsLoading(false);
            return;
        }

        const container = measurementRef.current;
        let foundFit = false;

        const unsafeHtml = await marked.parse(markdown);
        const cleanHtml = DOMPurify.sanitize(unsafeHtml);
        container.innerHTML = cleanHtml;

        // Determine columns to try: auto (4 -> 1) or user-selected fixed column count
        const columnsToTry = columnOption === 'auto' ? [4, 3, 2, 1] : [parseInt(columnOption, 10)];
        for (const numCols of columnsToTry) {
            const currentColumnWidthPt = (PAGE_WIDTH_PT - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (numCols - 1))) / numCols;
            // 两页高度阈值（px）
            const totalAvailableHeightPx = COLUMN_HEIGHT_PX * 2 * numCols;
            container.style.width = `${ptToPx(currentColumnWidthPt)}px`;

            // Inner loop for font size (MAX -> MIN)
            for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= FONT_STEP) {
                container.style.fontSize = `${fontSize}pt`;
                
                await new Promise(resolve => requestAnimationFrame(resolve));

                if (container.scrollHeight <= totalAvailableHeightPx) {
                    setFormattedHtml(cleanHtml);
                    setFinalFontSize(fontSize);
                    setFinalNumColumns(numCols);
                    setStatusMessage({ type: 'success', text: `排版成功！最佳布局为 ${numCols} 栏，字号 ${fontSize.toFixed(1)}pt。` });
                    foundFit = true;
                    break; // Exit font size loop
                }
            }
            if (foundFit) {
                break; // Exit columns loop
            }
        }

        if (!foundFit) {
            const chosenCols = columnOption === 'auto' ? null : parseInt(columnOption, 10);
            setStatusMessage({ type: 'error', text: chosenCols
                ? `内容太多，即使在最小字号和所选 ${chosenCols} 栏布局下也无法排入两页。请删减部分内容或选择更多分栏数。`
                : '内容太多，即使在最小字号和1栏布局下也无法排入两页。请删减部分内容。' });
            setFormattedHtml('');
            setFinalFontSize(null);
            setFinalNumColumns(2);
        }

        container.innerHTML = '';
        setIsLoading(false);
    }, [markdown, columnOption]);

    // When column option changes, only update column count; keep current font size.
    useEffect(() => {
        if (!formattedHtml) return;
        if (columnOption === 'auto') return; // Auto layout only when clicking "智能排版"
        const chosenCols = parseInt(columnOption, 10);
        if (Number.isFinite(chosenCols)) {
            setFinalNumColumns(chosenCols);
        }
    }, [columnOption, formattedHtml]);

    // 动态加载 html2canvas
    const ensureHtml2Canvas = async (): Promise<any> => {
        const anyWin = window as any;
        if (anyWin.html2canvas) return anyWin.html2canvas;
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load html2canvas'));
            document.head.appendChild(script);
        });
        return (window as any).html2canvas;
    };

    const handlePrint = async () => {
        if (!formattedHtml || !finalFontSize || !finalNumColumns) return;
        setIsLoading(true);
        try {
            const html2canvas = await ensureHtml2Canvas();
            const pageNodes = Array.from(document.querySelectorAll('.preview-page')) as HTMLElement[];
            if (pageNodes.length === 0) return;

            const scale = EXPORT_DPI / 96; // 提升到目标 DPI
            const images: string[] = [];

            for (const pageEl of pageNodes) {
                const prevShadow = pageEl.style.boxShadow;
                pageEl.style.boxShadow = 'none';
                const canvas: HTMLCanvasElement = await html2canvas(pageEl, {
                    backgroundColor: '#ffffff',
                    width: PAGE_WIDTH_PX,
                    height: PAGE_HEIGHT_PX,
                    scale,
                    useCORS: true,
                    allowTaint: true
                });
                pageEl.style.boxShadow = prevShadow;
                const dataUrl = canvas.toDataURL('image/jpeg', EXPORT_IMAGE_QUALITY);
                images.push(dataUrl);
            }

            const styles = `
                @page { size: A4; margin: 0; }
                html, body { margin:0; padding:0; -webkit-print-color-adjust: exact; color-adjust: exact; }
                .page { width:${PAGE_WIDTH_PX}px; height:${PAGE_HEIGHT_PX}px; page-break-after: always; }
                .page img { width:100%; height:100%; object-fit: contain; }
            `;

            const html = `
                <html>
                    <head>
                        <title>Print</title>
                        <style>${styles}</style>
                    </head>
                    <body>
                        ${images.map(src => `<div class=\"page\"><img src=\"${src}\"/></div>`).join('')}
                    </body>
                </html>
            `;

            const printWindow = window.open('', '_blank');
            if (printWindow) {
                printWindow.document.write(html);
                printWindow.document.close();
                const doPrint = () => {
                    try { printWindow.focus(); printWindow.print(); } catch (e) { console.error('Printing failed:', e); }
                };
                printWindow.addEventListener('afterprint', () => printWindow.close());
                setTimeout(doPrint, 600);
            }
        } finally {
            setIsLoading(false);
        }
    };

    const adjustFontSize = (delta: number) => {
        if (!finalFontSize || !formattedHtml) return;

        const newSize = finalFontSize + delta;
        if (newSize < MIN_FONT_SIZE || newSize > MAX_FONT_SIZE) return;

        setFinalFontSize(newSize);
    };


    // Calculate column-dependent values for rendering (px)
    const columnWidth = (PAGE_WIDTH_PX - (PAGE_PADDING_PX * 2) - (COLUMN_GAP_PX * (finalNumColumns - 1))) / finalNumColumns;

    return (
        <div className="bg-slate-100 min-h-screen font-sans text-slate-800">
            <style>
                {`
                @media print {
                    body { margin: 0; padding: 0; }
                    .no-print { display: none !important; }
                }
                .prose-styles h1, .prose-styles h2, .prose-styles h3, .prose-styles h4, .prose-styles h5, .prose-styles h6 { color: #1e293b; }
                .prose-styles p, .prose-styles li { color: #334155; }
                .prose-styles a { color: #2563eb; }
                .prose-styles blockquote { border-left-color: #94a3b8; color: #475569; border-left-width: 4px; padding-left: 1em;}
                .prose-styles code { color: #e11d48; background-color: #f8fafc; padding: 0.1em 0.3em; border-radius: 4px; }
                .prose-styles pre { background-color: #f1f5f9; padding: 1em; border-radius: 4px; }
                `}
            </style>
            
            <div ref={measurementRef} style={{
                position: 'absolute',
                visibility: 'hidden',
                top: '-9999px',
                left: '-9999px',
                lineHeight: '1.6'
            }} className="prose-styles"></div>

            <header className="bg-white shadow-sm p-4 no-print">
                <div className="container mx-auto flex justify-between items-center">
                    <h1 className="text-2xl font-bold text-slate-700">Markdown 页面适配器</h1>
                </div>
            </header>

            <main className="container mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="flex flex-col no-print">
                    <div className="bg-white rounded-lg shadow-lg flex-grow flex flex-col">
                        <div className="p-4 border-b border-slate-200">
                            <h2 className="text-lg font-semibold">输入 Markdown 内容</h2>
                        </div>
                        <textarea
                            value={markdown}
                            onChange={(e) => setMarkdown(e.target.value)}
                            className="w-full h-full flex-grow p-4 border-0 resize-none focus:ring-0 text-sm leading-6"
                            placeholder="在此处输入或粘贴您的 Markdown..."
                            style={{minHeight: '60vh'}}
                        />
                         <div className="p-4 border-t border-slate-200 flex items-center justify-between bg-slate-50 rounded-b-lg">
                            {statusMessage ? (
                                <div className={`flex items-center text-sm ${statusMessage.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                                    {statusMessage.type === 'success' ? 
                                        <CheckCircleIcon className="w-5 h-5 mr-2" /> : 
                                        <ExclamationTriangleIcon className="w-5 h-5 mr-2" />
                                    }
                                    <span>{statusMessage.text}</span>
                                </div>
                            ) : <div/> /* Placeholder to keep layout consistent */}
                            <button
                                onClick={handleFormat}
                                disabled={isLoading}
                                className="ml-auto bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors duration-200 disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center"
                            >
                                {isLoading ? (
                                    <>
                                        <SpinnerIcon className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
                                        处理中...
                                    </>
                                ) : (
                                    '智能排版'
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col">
                     <div className="bg-white rounded-lg shadow-lg flex-grow flex flex-col items-center p-4 sm:p-8">
                        <div className="w-full flex justify-between items-center mb-4 no-print">
                            <h2 className="text-lg font-semibold">{`排版预览 (${totalPages}页 / ${finalNumColumns}栏)`}</h2>
                             <div className="flex items-center gap-2">
                                <span className="text-sm text-slate-500">分栏:</span>
                                <select
                                    value={columnOption}
                                    onChange={(e) => setColumnOption(e.target.value as 'auto' | '1' | '2' | '3' | '4')}
                                    className="text-sm border border-slate-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    aria-label="选择分栏数"
                                >
                                    <option value="auto">自动</option>
                                    <option value="1">1栏</option>
                                    <option value="2">2栏</option>
                                    <option value="3">3栏</option>
                                    <option value="4">4栏</option>
                                </select>
                                <div className="w-px h-6 bg-slate-200 mx-2"></div>
                                <span className="text-sm text-slate-500">字号:</span>
                                <button
                                    onClick={() => adjustFontSize(-FONT_STEP)}
                                    disabled={!formattedHtml || isLoading || (finalFontSize && finalFontSize <= MIN_FONT_SIZE)}
                                    className="w-7 h-7 flex items-center justify-center bg-slate-200 text-slate-700 font-bold rounded-md hover:bg-slate-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                                    aria-label="减小字号"
                                >-</button>
                                <span className="text-sm font-medium text-slate-700 w-16 text-center tabular-nums">
                                    {finalFontSize ? `${finalFontSize.toFixed(1)}pt` : '-'}
                                </span>
                                <button
                                    onClick={() => adjustFontSize(FONT_STEP)}
                                    disabled={!formattedHtml || isLoading || (finalFontSize && finalFontSize >= MAX_FONT_SIZE)}
                                     className="w-7 h-7 flex items-center justify-center bg-slate-200 text-slate-700 font-bold rounded-md hover:bg-slate-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                                    aria-label="增大字号"
                                >+</button>
                                <div className="w-px h-6 bg-slate-200 mx-2"></div>
                                <button 
                                    onClick={handlePrint} 
                                    disabled={!formattedHtml || isLoading}
                                    className="bg-slate-600 text-white font-bold py-1.5 px-4 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 transition-colors duration-200 disabled:bg-slate-400 disabled:cursor-not-allowed text-sm"
                                >
                                    打印
                                </button>
                            </div>
                        </div>
                        
                        {/* Screen-only Preview */}
                                <div className="no-print flex flex-col items-center gap-4">
                            {Array.from({ length: totalPages }).map((_, pageIndex) => (
                                <div key={pageIndex} className="bg-white shadow-xl preview-page" style={{width: `${PAGE_WIDTH_PX}px`, height: `${PAGE_HEIGHT_PX}px`}}>
                                    <div className="h-full flex" style={{padding: `${PAGE_PADDING_PX}px`, gap: `${COLUMN_GAP_PX}px`}}>
                                        {Array.from({ length: finalNumColumns }).map((_, colIndex) => {
                                            const overallColumnIndex = pageIndex * finalNumColumns + colIndex;
                                            const translateY = -COLUMN_HEIGHT_PX * overallColumnIndex;
                                            
                                            if (!formattedHtml && overallColumnIndex > 0) return <div key={colIndex} style={{width: `${columnWidth}px`}}/>;

                                            return (
                                                <div key={colIndex} style={{width: `${columnWidth}px`, height: `${COLUMN_HEIGHT_PX}px`, overflow: 'hidden'}}>
                                                    <div
                                                        className="prose-styles"
                                                        style={{
                                                            fontSize: finalFontSize ? `${finalFontSize}pt` : '12pt',
                                                            lineHeight: 1.6,
                                                            transition: 'font-size 0.3s ease-in-out',
                                                            transform: `translateY(${translateY}px)`,
                                                            width: `${columnWidth}px`
                                                        }}
                                                        dangerouslySetInnerHTML={{ __html: formattedHtml || (overallColumnIndex === 0 ? '<p class="text-slate-400 pt-10">点击“智能排版”后，这里将显示预览。</p>' : '') }}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                     </div>
                </div>
            </main>
        </div>
    );
};

export default App;
