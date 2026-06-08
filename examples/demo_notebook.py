import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")


@app.cell
def intro():
    import marimo as mo
    mo.md("# Agent Performance Dashboard")
    return (mo,)


@app.cell
def data_setup():
    import pandas as pd
    import seaborn as sns

    data = pd.DataFrame({
        "agent": ["web", "api", "Ghostfolio", "analytics", "Homelab"],
        "tasks_completed": [12, 8, 15, 3, 7],
        "avg_duration_min": [4.2, 6.1, 3.8, 12.5, 5.0],
        "blocked_count": [2, 5, 1, 8, 3],
        "state": ["working", "idle", "done", "blocked", "working"],
    })
    return data, pd


@app.cell
def chart(data):
    import altair as alt

    chart = alt.Chart(data).mark_bar().encode(
        x="agent",
        y="tasks_completed",
        color=alt.Color("state", scale=alt.Scale(
            domain=["working", "idle", "done", "blocked"],
            range=["#58a6ff", "#6e7681", "#3fb950", "#ff7b72"],
        )),
    ).properties(width=400, height=300, title="Tasks Completed by Agent")
    return (alt,)


@app.cell
def summary(data, mo):
    total = data["tasks_completed"].sum()
    blocked = data[data["state"] == "blocked"].shape[0]
    mo.md(f"""
    ## Summary
    - **Total tasks completed**: {total}
    - **Agents blocked**: {blocked}
    - **Average duration**: {data['avg_duration_min'].mean():.1f} min
    """)
    return


@app.cell
def efficiency_chart(alt, data):
    scatter = alt.Chart(data).mark_circle(size=120).encode(
        x=alt.X("avg_duration_min", title="Avg Duration (min)"),
        y=alt.Y("blocked_count", title="Times Blocked"),
        color=alt.Color("state", scale=alt.Scale(
            domain=["working", "idle", "done", "blocked"],
            range=["#58a6ff", "#6e7681", "#3fb950", "#ff7b72"],
        )),
        size=alt.Size("tasks_completed", scale=alt.Scale(range=[60, 400])),
        tooltip=["agent", "tasks_completed", "avg_duration_min", "blocked_count"],
    ).properties(width=400, height=300, title="Agent Efficiency: Duration vs Blocks")
    return (scatter,)


@app.cell
def _(scatter):
    scatter
    return


@app.cell
def heatmap(alt, data, pd):
    heat_data = pd.DataFrame([
        {"agent": a, "metric": m, "value": float(data.loc[data["agent"] == a, col].iloc[0])}
        for a in data["agent"]
        for m, col in [("Tasks", "tasks_completed"), ("Duration", "avg_duration_min"), ("Blocked", "blocked_count")]
    ])
    hm = alt.Chart(heat_data).mark_rect().encode(
        x=alt.X("metric:N", title=None),
        y=alt.Y("agent:N", title=None),
        color=alt.Color("value:Q", scale=alt.Scale(scheme="blues")),
        tooltip=["agent", "metric", "value"],
    ).properties(width=300, height=200, title="Agent Metrics Heatmap")
    return (hm,)


@app.cell
def _(hm):
    hm
    return


if __name__ == "__main__":
    app.run()
