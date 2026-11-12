# A boundary splits by default and the transition run decides its state

_Superseded by ADR-0029._

A boundary, meaning a change of Artifact hash or setup hash between consecutive Runs on a Series, splits the Series and is joined only by a transition run that shows no movement. An Annotation at a hash boundary explains and never decides; at a timestamp anchor it creates the boundary. The alternative from the original #13 resolution, treating unannotated boundaries as comparable and relying on regression detection to catch mistakes, was rejected because detection cannot be trusted to catch every change and the data must stay honest with detection switched off.
