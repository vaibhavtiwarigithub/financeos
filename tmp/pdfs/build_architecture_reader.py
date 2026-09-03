from __future__ import annotations

import re
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf" / "kairos-architecture-and-micro-architecture-reader.pdf"


def ascii_text(value: str) -> str:
    replacements = {
        "\u2014": " - ", "\u2013": "-", "\u2011": "-", "\u2010": "-",
        "\u2192": "->", "\u2190": "<-", "\u2265": ">=", "\u2264": "<=",
        "\u2212": "-", "\u00d7": "x", "\u2026": "...", "\u2018": "'",
        "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2022": "*",
        "\u2713": "[yes]", "\u2717": "[no]", "\u2194": "<->",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return value.encode("ascii", "replace").decode("ascii")


class NumberedDocTemplate(BaseDocTemplate):
    def __init__(self, filename: Path):
        frame = Frame(0.65 * inch, 0.62 * inch, 7.2 * inch, 9.55 * inch, id="body")
        super().__init__(str(filename), pagesize=letter, rightMargin=0, leftMargin=0, topMargin=0, bottomMargin=0)
        self.addPageTemplates(PageTemplate(id="reader", frames=[frame], onPage=self.draw_footer))
        self._bookmark_index = 0

    def beforeDocument(self):
        # multiBuild lays the document out repeatedly until the TOC page numbers
        # settle. Bookmark names must stay identical across those passes.
        self._bookmark_index = 0

    def draw_footer(self, canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#D9DEE7"))
        canvas.line(0.65 * inch, 0.45 * inch, 7.85 * inch, 0.45 * inch)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#5D6777"))
        canvas.drawString(0.65 * inch, 0.28 * inch, "Kairos Architecture and Micro-Architecture Reader | 2026-08-01")
        canvas.drawRightString(7.85 * inch, 0.28 * inch, f"Page {doc.page}")
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and hasattr(flowable, "toc_level"):
            level = flowable.toc_level
            # The reader contains almost 100 source documents. Listing every
            # Markdown subheading turns the printed TOC into dozens of pages;
            # keep it at source-document/section granularity.
            if level != 0:
                return
            text = flowable.getPlainText()
            key = f"section-{self._bookmark_index}"
            self._bookmark_index += 1
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=level, closed=level > 0)


def make_styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("ReaderTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=25, leading=31, textColor=colors.HexColor("#172033"), alignment=TA_CENTER, spaceAfter=18),
        "subtitle": ParagraphStyle("ReaderSubtitle", parent=base["BodyText"], fontName="Helvetica", fontSize=12, leading=17, textColor=colors.HexColor("#4B5565"), alignment=TA_CENTER, spaceAfter=20),
        "h1": ParagraphStyle("ReaderH1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=22, textColor=colors.HexColor("#172033"), spaceBefore=18, spaceAfter=10, keepWithNext=True),
        "h2": ParagraphStyle("ReaderH2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=colors.HexColor("#1F4E79"), spaceBefore=14, spaceAfter=7, keepWithNext=True),
        "h3": ParagraphStyle("ReaderH3", parent=base["Heading3"], fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=colors.HexColor("#334155"), spaceBefore=10, spaceAfter=5, keepWithNext=True),
        "body": ParagraphStyle("ReaderBody", parent=base["BodyText"], fontName="Helvetica", fontSize=9.2, leading=13.1, spaceAfter=6, textColor=colors.HexColor("#1F2937"), alignment=TA_LEFT),
        "bullet": ParagraphStyle("ReaderBullet", parent=base["BodyText"], fontName="Helvetica", fontSize=9.1, leading=12.7, leftIndent=15, firstLineIndent=-10, spaceAfter=4, textColor=colors.HexColor("#1F2937")),
        "code": ParagraphStyle("ReaderCode", fontName="Courier", fontSize=7.2, leading=9.0, leftIndent=8, rightIndent=8, spaceBefore=4, spaceAfter=8, textColor=colors.HexColor("#26364A")),
        "source": ParagraphStyle("ReaderSource", parent=base["BodyText"], fontName="Helvetica-Oblique", fontSize=8, leading=11, textColor=colors.HexColor("#5D6777"), spaceAfter=12),
        "toc": ParagraphStyle("ReaderTOC", fontName="Helvetica", fontSize=9, leading=12, leftIndent=14, firstLineIndent=-14, textColor=colors.HexColor("#26364A")),
    }


STYLES = make_styles()


def para(text: str, style: str = "body", toc_level: int | None = None):
    clean = ascii_text(text).strip()
    clean = escape(clean)
    clean = re.sub(r"`([^`]+)`", r"<font name='Courier'>\1</font>", clean)
    # Keep inline code literal and safe. Markdown emphasis can nest around code
    # fragments such as lib/risk/*, so remove bold markers rather than inserting
    # rich-text tags that can corrupt ReportLab's tag stack.
    clean = clean.replace("**", "")
    clean = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", clean)
    item = Paragraph(clean, STYLES[style])
    if toc_level is not None:
        item.toc_level = toc_level
    return item


def title(text: str, level: int):
    style = "h1" if level == 0 else "h2" if level == 1 else "h3"
    return para(text, style, toc_level=level)


def source_label(path: Path, category: str):
    return para(f"Source: {path.relative_to(ROOT)} | {category}", "source")


def display_title(path: Path) -> str:
    if path.name == "FEATURE_ARCHITECTURE.md":
        return f"{path.parent.name.replace('-', ' ')} - Feature Architecture"
    return path.stem.replace("_", " ")


def is_table_separator(line: str) -> bool:
    return bool(re.match(r"^\s*\|?\s*:?-{3,}", line))


def markdown_to_story(path: Path, category: str, document_title: str):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    story = [title(document_title, 0), source_label(path, category)]
    i = 0
    pending: list[str] = []

    def flush_pending():
        nonlocal pending
        if pending:
            text = " ".join(part.strip() for part in pending).strip()
            if text:
                story.append(para(text))
            pending = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("```"):
            flush_pending()
            code: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(ascii_text(lines[i].rstrip()))
                i += 1
            if code:
                story.append(Preformatted("\n".join(code), STYLES["code"], maxLineLength=108))
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", stripped)
        if heading:
            flush_pending()
            # Feature documents are authored independently and can begin at any
            # Markdown depth. Keep the PDF outline valid and compact: source
            # documents are level 0, every internal heading is level 1.
            level = 1
            story.append(title(heading.group(2), level))
            i += 1
            continue
        if stripped in {"---", "***", "___"}:
            flush_pending()
            story.append(Spacer(1, 6))
            i += 1
            continue
        if stripped.startswith("|") and "|" in stripped[1:]:
            flush_pending()
            table_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                if not is_table_separator(lines[i]):
                    table_lines.append(lines[i].strip())
                i += 1
            if table_lines:
                rendered = "\n".join(ascii_text(row) for row in table_lines)
                story.append(Preformatted(rendered, STYLES["code"], maxLineLength=108))
            continue
        bullet = re.match(r"^(?:[-*+] |\d+\. )(.*)$", stripped)
        if bullet:
            flush_pending()
            story.append(para("- " + bullet.group(1), "bullet"))
            i += 1
            continue
        if not stripped:
            flush_pending()
            i += 1
            continue
        if stripped.startswith(">"):
            flush_pending()
            story.append(para(stripped.lstrip("> "), "source"))
            i += 1
            continue
        pending.append(stripped)
        i += 1
    flush_pending()
    story.append(PageBreak())
    return story


def document_list():
    foundational = [
        (ROOT / "SYSTEM_OVERVIEW.md", "Authoritative system orientation"),
        (ROOT / "ARCHITECTURE.md", "Authoritative documentation portal"),
        (ROOT / "PRD.md", "Product requirements and conventions"),
    ]
    chapters = [(p, "Authoritative operational architecture") for p in sorted((ROOT / "docs" / "arch").glob("*.md"))]
    decisions = [(ROOT / "PROJECT_DECISIONS.md", "Decision and rationale ledger")]
    features = [(p, "Feature micro-architecture: verify lifecycle status within the document and any IMPLEMENTATION_RESULT.md") for p in sorted((ROOT / "features").glob("**/FEATURE_ARCHITECTURE.md")) if p.parent.name != "_template"]
    return foundational, chapters, decisions, features


def cover_page(story):
    story.extend([
        Spacer(1, 2.05 * inch),
        Paragraph("Kairos", STYLES["title"]),
        Paragraph("Architecture and Micro-Architecture Reader", STYLES["title"]),
        Paragraph("Print edition - generated 2026-08-01", STYLES["subtitle"]),
        Spacer(1, 0.45 * inch),
        para("This reader combines the current architecture chapters, product context, approved decision ledger, and every feature micro-architecture. The shared chapters in docs/arch are the operational source of truth. Feature documents may describe shipped work, a shadow, a proposal, a deferred idea, or a rejected direction; read their lifecycle language and any IMPLEMENTATION_RESULT.md before treating them as live behavior.", "body"),
        Spacer(1, 0.25 * inch),
        para("Reading route: overview -> agents and schedules -> providers and database -> safety -> learning -> the feature appendices that match the area you want to investigate.", "body"),
        PageBreak(),
    ])


def reader_map(story, sections):
    story.append(title("Reader Map", 0))
    story.append(para("Read Foundation and Operational Architecture in order. The Decision ledger explains why consequential choices were made. The final appendix contains every feature micro-architecture alphabetically; these are design records and may describe live work, a shadow, a proposal, a deferred item, or a retired direction.", "body"))
    section_names = ["Foundation", "Operational Architecture", "Decisions and Rationale", "Feature Micro-Architecture Appendix"]
    for section_name, entries in zip(section_names, sections):
        story.append(para(section_name, "h2"))
        for path, _category in entries:
            story.append(para(display_title(path), "body"))
            story.append(Spacer(1, 2))
    story.append(PageBreak())


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = NumberedDocTemplate(OUTPUT)
    story = []
    cover_page(story)
    sections = document_list()
    reader_map(story, sections)
    section_names = ["Foundation", "Operational Architecture", "Decisions and Rationale", "Feature Micro-Architecture Appendix"]
    for section_name, entries in zip(section_names, sections):
        story.append(title(section_name, 0))
        if section_name == "Feature Micro-Architecture Appendix":
            story.append(para("These documents are intentionally preserved as design history. They are not all active product behavior. Use the lifecycle statement inside each document, its implementation result when present, and the shared architecture chapters to determine what is actually live.", "body"))
        story.append(PageBreak())
        for path, category in entries:
            story.extend(markdown_to_story(path, category, display_title(path)))

    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    build()
