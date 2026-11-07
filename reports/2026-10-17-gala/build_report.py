import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import matplotlib.pyplot as plt
from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.fill import ColorChoice, PatternFillProperties
from openpyxl.drawing.image import Image as XlImage
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart.legend import Legend
from openpyxl.chart.marker import Marker

ROOT = Path(__file__).resolve().parent
CHARTS = ROOT / "charts"
LOCAL = timezone(timedelta(hours=-7))
EVENT = "Saturday, October 17, 2026"
NAVY = "1B3A4B"
TEAL = "0E7C7B"
ORANGE = "D4762C"
INK = "1F2933"
MUTED = "52606D"
PALE = "F4F7F8"
PALE_TEAL = "E5F4F3"
PALE_ORANGE = "FBF1E8"
WHITE = "FFFFFF"
LINE = "D9E2EC"

plt.rcParams.update({
    "font.family": "Segoe UI",
    "axes.edgecolor": "#D9E2EC",
    "axes.labelcolor": "#1F2933",
    "xtick.color": "#52606D",
    "ytick.color": "#52606D",
    "text.color": "#1F2933",
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "axes.titleweight": "semibold",
})


def parse(text):
    patterns = [
        (r"^(\d{5}) scanned again at the .+ by (.+)$", "scan", "Desk", "Scanned again"),
        (r"^(\d{5}) scanned at the .+ by (.+)$", "scan", "Desk", "Scanned"),
        (r"^(\d{5}) food picked up: (.+) by (.+)$", "food", "Food", "Food picked up"),
        (r"^(\d{5}) reverted (?:Saturday |Sunday )?entry: (.+) by (.+)$", "entry-revert", "Desk", "Entry reverted"),
        (r"^(\d{5}) (?:Saturday |Sunday )?entry done: (.+) by (.+)$", "entry", "Desk", "Entry done"),
        (r"^(\d{5}) reverted (.+) by (.+)$", "revert", None, "Reverted"),
        (r"^(\d{5}) new sale for (.+) by (.+)$", "sale", "Desk", "New sale"),
        (r"^(\d{5}) sale changed for (.+) by (.+)$", "sale-change", "Desk", "Sale changed"),
        (r"^Bhoomi book × (\d+) checked out for (.+?)(?: \(([^)]+)\))? by (.+)$", "book", "Desk", "Bhoomi book"),
        (r"^admin cleared all scans$", "reset", "Desk", "Cleared practice scans"),
    ]
    for pattern, kind, section, action in patterns:
        match = re.match(pattern, text)
        if not match:
            continue
        if kind == "reset":
            return {"kind": kind, "section": section, "action": action, "code": "", "item": "", "staff": "admin", "guest": "", "email": "", "qty": ""}
        if kind == "book":
            qty, guest, email, staff = match.groups()
            return {"kind": kind, "section": section, "action": action, "code": "", "item": f"Bhoomi book × {qty}", "staff": staff, "guest": guest, "email": email or "", "qty": int(qty)}
        if kind == "scan":
            code, staff = match.groups()
            return {"kind": kind, "section": section, "action": action, "code": code, "item": "", "staff": staff, "guest": "", "email": "", "qty": 1}
        if kind in {"sale", "sale-change"}:
            code, guest, staff = match.groups()
            return {"kind": kind, "section": section, "action": action, "code": code, "item": "", "staff": staff, "guest": guest, "email": "", "qty": 1}
        code, item, staff = match.groups()
        section = section or ("Desk" if "entry" in item.lower() else "Food")
        action = "Food reverted" if section == "Food" and kind == "revert" else action
        return {"kind": kind, "section": section, "action": action, "code": code, "item": item, "staff": staff, "guest": "", "email": "", "qty": 1}
    return None


def load_rows():
    source = json.loads((ROOT / "source.json").read_text(encoding="utf-8"))
    people = source["people"]
    rows = []
    for raw in source["log"]:
        parsed = parse(raw["text"])
        if not parsed:
            raise SystemExit(f"Unrecognized log line: {raw['text']}")
        when = datetime.fromisoformat(raw["at"].replace("Z", "+00:00")).astimezone(LOCAL)
        person = people.get(parsed["code"], {})
        guest = parsed["guest"] or person.get("name") or ""
        email = parsed["email"] or person.get("email") or ""
        rows.append({
            **parsed,
            "at": when,
            "hour": when.strftime("%I %p").lstrip("0"),
            "hour_sort": when.hour,
            "time": when.strftime("%I:%M:%S %p").lstrip("0"),
            "guest": guest,
            "email": email,
            "sort_name": (guest or "zzz").casefold(),
        })
    return rows


def style_header(cell):
    cell.font = Font(name="Calibri", bold=True, color=WHITE, size=11)
    cell.fill = PatternFill("solid", fgColor=NAVY)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def write_table(ws, headers, records, fills):
    thin = Border(
        left=Side(style="thin", color=LINE),
        right=Side(style="thin", color=LINE),
        top=Side(style="thin", color=LINE),
        bottom=Side(style="thin", color=LINE),
    )
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{max(1, len(records) + 1)}"
    ws.row_dimensions[1].height = 24
    for col, header in enumerate(headers, 1):
        cell = ws.cell(1, col, header)
        style_header(cell)
    for index, record in enumerate(records, 2):
        fill = fills[index % 2]
        for col, value in enumerate(record, 1):
            cell = ws.cell(index, col, value)
            cell.font = Font(name="Calibri", size=11, color=INK)
            cell.fill = PatternFill("solid", fgColor=fill)
            cell.border = thin
            cell.alignment = Alignment(vertical="center", wrap_text=(col == 1))
        ws.row_dimensions[index].height = 18
    for col, header in enumerate(headers, 1):
        width = max(len(header), *(len(str(record[col - 1])) for record in records[:200])) if records else len(header)
        ws.column_dimensions[get_column_letter(col)].width = min(max(width + 3, 12), 42)
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.page_setup.paperSize = ws.PAPERSIZE_TABLOID
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.oddHeader.left.text = "Uttoron  ·  External Artist Gala"
    ws.oddFooter.right.text = "Page &P of &N"
    ws.print_title_rows = "1:1"
    ws.page_setup.horizontalCentered = True
    ws.sheet_view.zoomScale = 110
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{max(1, len(records) + 1)}"


def activity_record(row):
    return [row["hour"], row["time"], row["code"], row["guest"], row["email"], row["action"], row["item"], row["staff"]]


def save_chart(fig, name):
    CHARTS.mkdir(exist_ok=True)
    path = CHARTS / name
    fig.savefig(path, dpi=180, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def draw_hourly(hours, desk, food):
    fig, ax = plt.subplots(figsize=(11.2, 5.6))
    x = range(len(hours))
    width = 0.38
    ax.bar([i - width / 2 for i in x], desk, width, label="Desk", color="#0E7C7B")
    ax.bar([i + width / 2 for i in x], food, width, label="Food", color="#D4762C")
    ax.set_title("Activity by hour", loc="left", fontsize=18, pad=12)
    ax.text(0, 1.02, EVENT, transform=ax.transAxes, color="#52606D", fontsize=11)
    ax.set_xticks(list(x), hours)
    ax.set_ylabel("Actions")
    ax.legend(frameon=False, ncol=2)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.yaxis.grid(True, color="#E4E7EB")
    ax.set_axisbelow(True)
    for i, (d, f) in enumerate(zip(desk, food)):
        ax.text(i - width / 2, d + 1.5, str(d), ha="center", va="bottom", fontsize=8, color="#0E7C7B")
        ax.text(i + width / 2, f + 1.5, str(f), ha="center", va="bottom", fontsize=8, color="#D4762C")
    return save_chart(fig, "01-activity-by-hour.png")


def draw_bars(title, labels, values, color, filename, xlabel):
    fig, ax = plt.subplots(figsize=(11.2, max(4.8, 0.38 * len(labels) + 1.6)))
    y = range(len(labels))
    ax.barh(list(y), values, color=color)
    ax.set_yticks(list(y), labels)
    ax.invert_yaxis()
    ax.set_title(title, loc="left", fontsize=18, pad=12)
    ax.set_xlabel(xlabel)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.xaxis.grid(True, color="#E4E7EB")
    ax.set_axisbelow(True)
    for index, value in enumerate(values):
        ax.text(value + 0.4, index, str(value), va="center", fontsize=9, color="#1F2933")
    return save_chart(fig, filename)


def draw_staff(names, desk, food):
    fig, ax = plt.subplots(figsize=(11.2, 5.8))
    y = range(len(names))
    ax.barh(list(y), desk, color="#0E7C7B", label="Desk")
    ax.barh(list(y), food, left=desk, color="#D4762C", label="Food")
    ax.set_yticks(list(y), names)
    ax.invert_yaxis()
    ax.set_title("Actions by staff", loc="left", fontsize=18, pad=12)
    ax.set_xlabel("Actions")
    ax.legend(frameon=False, ncol=2)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.xaxis.grid(True, color="#E4E7EB")
    ax.set_axisbelow(True)
    return save_chart(fig, "04-staff.png")


def draw_cumulative(times, entry, food):
    fig, ax = plt.subplots(figsize=(11.2, 5.4))
    ax.plot(times, entry, color="#0E7C7B", linewidth=2.6, marker="o", label="Entry marked")
    ax.plot(times, food, color="#D4762C", linewidth=2.6, marker="o", label="Food picked up")
    ax.set_title("Running total through the evening", loc="left", fontsize=18, pad=12)
    ax.set_ylabel("Count")
    ax.legend(frameon=False)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.yaxis.grid(True, color="#E4E7EB")
    ax.set_axisbelow(True)
    for index, (entry_count, food_count) in enumerate(zip(entry, food)):
        ax.text(index, entry_count + 12, str(entry_count), ha="center", fontsize=8, color="#0E7C7B")
        if food_count:
            ax.text(index, food_count + 12, str(food_count), ha="center", fontsize=8, color="#D4762C")
    return save_chart(fig, "05-running-total.png")


def add_native_charts(wb, hourly_ws, food_ws, entry_ws, staff_ws):
    chart = BarChart()
    chart.type = "col"
    chart.grouping = "clustered"
    chart.title = "Activity by hour"
    chart.y_axis.title = "Actions"
    chart.style = 10
    data = Reference(hourly_ws, min_col=2, max_col=3, min_row=1, max_row=hourly_ws.max_row)
    cats = Reference(hourly_ws, min_col=1, min_row=2, max_row=hourly_ws.max_row)
    chart.add_data(data, titles_from_data=True)
    chart.set_categories(cats)
    chart.shape = 4
    chart.legend.position = "b"
    chart.y_axis.delete = False
    chart.x_axis.delete = False
    hourly_ws.add_chart(chart, "E2")

    food_chart = BarChart()
    food_chart.type = "bar"
    food_chart.title = "Food picked up"
    food_chart.style = 10
    food_data = Reference(food_ws, min_col=2, max_col=2, min_row=1, max_row=food_ws.max_row)
    food_cats = Reference(food_ws, min_col=1, min_row=2, max_row=food_ws.max_row)
    food_chart.add_data(food_data, titles_from_data=True)
    food_chart.set_categories(food_cats)
    food_chart.legend = None
    food_chart.shape = 4
    food_ws.add_chart(food_chart, "D2")

    entry_chart = BarChart()
    entry_chart.type = "bar"
    entry_chart.title = "Entry marked"
    entry_chart.style = 10
    entry_data = Reference(entry_ws, min_col=2, max_col=2, min_row=1, max_row=min(entry_ws.max_row, 16))
    entry_cats = Reference(entry_ws, min_col=1, min_row=2, max_row=min(entry_ws.max_row, 16))
    entry_chart.add_data(entry_data, titles_from_data=True)
    entry_chart.set_categories(entry_cats)
    entry_chart.legend = None
    entry_ws.add_chart(entry_chart, "D2")

    staff_chart = BarChart()
    staff_chart.type = "bar"
    staff_chart.grouping = "stacked"
    staff_chart.title = "Actions by staff"
    staff_chart.style = 10
    staff_data = Reference(staff_ws, min_col=2, max_col=3, min_row=1, max_row=staff_ws.max_row)
    staff_cats = Reference(staff_ws, min_col=1, min_row=2, max_row=staff_ws.max_row)
    staff_chart.add_data(staff_data, titles_from_data=True)
    staff_chart.set_categories(staff_cats)
    staff_chart.legend.position = "b"
    staff_ws.add_chart(staff_chart, "E2")


def main():
    rows = load_rows()
    rows.sort(key=lambda row: (row["hour_sort"], row["sort_name"], row["at"], row["action"]))
    desk = [row for row in rows if row["section"] == "Desk"]
    food = [row for row in rows if row["section"] == "Food"]
    headers = ["Hour", "Time", "Order", "Name", "Email", "Action", "Item", "Staff"]

    hours = list(range(min(row["hour_sort"] for row in rows), max(row["hour_sort"] for row in rows) + 1))
    hour_labels = [datetime(2026, 10, 17, hour).strftime("%I %p").lstrip("0") for hour in hours]
    desk_counts = [sum(1 for row in desk if row["hour_sort"] == hour) for hour in hours]
    food_counts = [sum(1 for row in food if row["hour_sort"] == hour) for hour in hours]

    food_items = defaultdict(int)
    for row in food:
        if row["kind"] == "food":
            food_items[row["item"]] += 1
    food_ranked = sorted(food_items.items(), key=lambda item: (-item[1], item[0].casefold()))

    entry_items = defaultdict(int)
    for row in desk:
        if row["kind"] == "entry":
            entry_items[row["item"]] += 1
    entry_ranked = sorted(entry_items.items(), key=lambda item: (-item[1], item[0].casefold()))

    staff = sorted({row["staff"] for row in rows}, key=str.casefold)
    staff_desk = [sum(1 for row in desk if row["staff"] == name) for name in staff]
    staff_food = [sum(1 for row in food if row["staff"] == name) for name in staff]

    entry_total = 0
    food_total = 0
    running = {hour: [0, 0] for hour in hours}
    for row in sorted(rows, key=lambda item: item["at"]):
        if row["kind"] == "entry":
            entry_total += 1
        elif row["kind"] == "entry-revert":
            entry_total -= 1
        elif row["kind"] == "food":
            food_total += 1
        elif row["kind"] == "revert" and row["section"] == "Food":
            food_total -= 1
        running[row["hour_sort"]] = [entry_total, food_total]
    carried = [0, 0]
    for hour in hours:
        if hour in {row["hour_sort"] for row in rows}:
            carried = running[hour]
        else:
            running[hour] = carried[:]
    chart_times = hour_labels
    running_entry_plot = [running[hour][0] for hour in hours]
    running_food_plot = [running[hour][1] for hour in hours]

    chart_paths = [
        draw_hourly(hour_labels, desk_counts, food_counts),
        draw_bars("Food picked up", [name for name, _ in food_ranked], [count for _, count in food_ranked], "#D4762C", "02-food-picked-up.png", "Plates"),
        draw_bars("Entry marked at the desk", [name for name, _ in entry_ranked], [count for _, count in entry_ranked], "#0E7C7B", "03-entry-marked.png", "Tickets marked"),
        draw_staff(staff, staff_desk, staff_food),
        draw_cumulative(chart_times, running_entry_plot, running_food_plot),
    ]

    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"

    desk_ws = wb.create_sheet("Desk by hour")
    food_ws = wb.create_sheet("Food by hour")
    desk_alpha = wb.create_sheet("Desk A to Z")
    food_alpha = wb.create_sheet("Food A to Z")
    hourly_ws = wb.create_sheet("By hour")
    items_ws = wb.create_sheet("Food items")
    entry_ws = wb.create_sheet("Entry items")
    staff_ws = wb.create_sheet("Staff")
    charts_ws = wb.create_sheet("Charts")

    write_table(desk_ws, headers, [activity_record(row) for row in desk], [WHITE, PALE_TEAL])
    write_table(food_ws, headers, [activity_record(row) for row in food], [WHITE, PALE_ORANGE])
    write_table(desk_alpha, headers, [activity_record(row) for row in sorted(desk, key=lambda row: (row["sort_name"], row["at"]))], [WHITE, PALE_TEAL])
    write_table(food_alpha, headers, [activity_record(row) for row in sorted(food, key=lambda row: (row["sort_name"], row["at"]))], [WHITE, PALE_ORANGE])

    write_table(hourly_ws, ["Hour", "Desk actions", "Food actions", "Total"], [
        [label, desk_counts[index], food_counts[index], desk_counts[index] + food_counts[index]]
        for index, label in enumerate(hour_labels)
    ], [WHITE, PALE])
    write_table(items_ws, ["Food", "Picked up"], [[name, count] for name, count in food_ranked], [WHITE, PALE_ORANGE])
    write_table(entry_ws, ["Entry", "Marked done"], [[name, count] for name, count in entry_ranked], [WHITE, PALE_TEAL])
    write_table(staff_ws, ["Staff", "Desk actions", "Food actions", "Total"], [
        [name, staff_desk[index], staff_food[index], staff_desk[index] + staff_food[index]]
        for index, name in enumerate(staff)
    ], [WHITE, PALE])

    add_native_charts(wb, hourly_ws, items_ws, entry_ws, staff_ws)

    summary.sheet_view.showGridLines = False
    summary.merge_cells("B2:G2")
    summary["B2"] = "External Artist Gala"
    summary["B2"].font = Font(name="Calibri", size=28, bold=True, color=NAVY)
    summary.merge_cells("B3:G3")
    summary["B3"] = f"{EVENT}  ·  door log, Pacific time"
    summary["B3"].font = Font(name="Calibri", size=14, color=MUTED)
    summary.merge_cells("B4:G4")
    summary["B4"] = "Desk actions are listed by hour, then by guest name. Food pickups are in their own section, sorted the same way."
    summary["B4"].font = Font(name="Calibri", size=12, color=INK)

    kpis = [
        ("Desk actions", len(desk), TEAL),
        ("Food actions", len(food), ORANGE),
        ("Entry marked", sum(1 for row in desk if row["kind"] == "entry"), TEAL),
        ("Entry reverts", sum(1 for row in desk if row["kind"] == "entry-revert"), "9A3412"),
        ("Food picked up", sum(1 for row in food if row["kind"] == "food"), ORANGE),
        ("Guests scanned", len({row["code"] for row in desk if row["kind"] == "scan" and row["code"]}), NAVY),
    ]
    for index, (label, value, color) in enumerate(kpis):
        column = 2 + index
        summary.cell(6, column, value).font = Font(name="Calibri", size=26, bold=True, color=color)
        summary.cell(6, column).alignment = Alignment(horizontal="center")
        summary.cell(7, column, label).font = Font(name="Calibri", size=11, color=MUTED)
        summary.cell(7, column).alignment = Alignment(horizontal="center")

    summary["B9"] = "What is in this workbook"
    summary["B9"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
    notes = [
        "Desk by hour and Food by hour are the working logs. Inside each hour, names run A to Z.",
        "Desk A to Z and Food A to Z are the same rows sorted by guest name.",
        "By hour, Food items, Entry items, and Staff include the charts used for the slides.",
        "The Charts sheet shows the same pictures saved in the charts folder next to this file.",
        "The first line of the day is the practice-scan clear at 1:45 PM. Test2 is a practice book sale.",
    ]
    for index, note in enumerate(notes):
        summary.cell(10 + index, 2, note).font = Font(name="Calibri", size=12, color=INK)
        summary.merge_cells(start_row=10 + index, start_column=2, end_row=10 + index, end_column=7)

    summary.row_dimensions[2].height = 36
    summary.row_dimensions[6].height = 34
    for column, width in enumerate([3, 22, 18, 18, 18, 20, 22], 1):
        summary.column_dimensions[get_column_letter(column)].width = width
    summary.page_setup.orientation = "landscape"
    summary.page_setup.fitToPage = True
    summary.page_setup.fitToWidth = 1
    summary.page_setup.fitToHeight = 1
    summary.sheet_properties.pageSetUpPr.fitToPage = True
    summary.sheet_view.zoomScale = 120
    summary.oddHeader.left.text = "Uttoron  ·  External Artist Gala"
    summary.print_area = "A1:G20"

    charts_ws.sheet_view.showGridLines = False
    charts_ws["A1"] = "Charts for the presentation"
    charts_ws["A1"].font = Font(name="Calibri", size=20, bold=True, color=NAVY)
    charts_ws["A2"] = "These are the same files in the charts folder."
    charts_ws["A2"].font = Font(name="Calibri", size=12, color=MUTED)
    charts_ws.column_dimensions["A"].width = 18
    row = 4
    for path in chart_paths:
        image = XlImage(str(path))
        image.width = 720
        image.height = int(720 * image.height / image.width)
        charts_ws.add_image(image, f"A{row}")
        row += int(image.height / 18) + 2
    charts_ws.page_setup.orientation = "landscape"
    charts_ws.page_setup.fitToPage = True
    charts_ws.page_setup.fitToWidth = 1
    charts_ws.page_setup.fitToHeight = 0
    charts_ws.sheet_properties.pageSetUpPr.fitToPage = True
    charts_ws.page_setup.paperSize = charts_ws.PAPERSIZE_TABLOID

    for ws in wb.worksheets:
        ws.sheet_properties.tabColor = TEAL if "Desk" in ws.title or ws.title == "Entry items" else ORANGE if "Food" in ws.title else NAVY
        ws.page_setup.horizontalCentered = True
        ws.sheet_view.view = "pageBreakPreview"
        ws.sheet_view.view = "normal"
        ws.page_margins.left = 0.5
        ws.page_margins.right = 0.5
        ws.page_margins.top = 0.7
        ws.page_margins.bottom = 0.6
        ws.page_margins.header = 0.3
        ws.page_margins.footer = 0.3

    out = ROOT / "Gala-activity-Oct-17.xlsx"
    wb.save(out)
    print(f"rows {len(rows)} desk {len(desk)} food {len(food)}")
    print(out)
    for path in chart_paths:
        print(path)


if __name__ == "__main__":
    main()
