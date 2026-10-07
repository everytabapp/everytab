# EveryTab

EveryTab keeps live and saved browser work organized without changing the
meaning of the user's Labels or Sessions. This language distinguishes saved
content, recovery records, and the optional organization layer around them.

## Language

**Label**:
A user-named tag applied to saved or live tab references. Its identity is its
exact name.
_Avoid_: Folder, category

**Named Session**:
A durable, editable, named template of one or more browser windows. Restoring it
does not consume it.
_Avoid_: Workspace, folder

**Snapshot**:
An automatic, immutable Session record kept for recovery. It is not a Named
Session and cannot be organized into a Session group.
_Avoid_: Session group member

**Label group**:
An optional one-level organization container whose members are Labels. It does
not apply Labels and contains no links or tabs itself.
_Avoid_: Folder, Area

**Session group**:
An optional one-level organization container whose members are Named Sessions.
It contains no tabs, windows, Snapshots, or Chrome tab-group templates itself.
_Avoid_: Folder, Area, Chrome tab group

**Chrome tab-group template**:
Saved browser-native tab grouping information inside a Session, including group
membership, title, color, and collapsed state.
_Avoid_: Session group

**Organization membership**:
An explicit association between one Label or Named Session and one organization
group. A member can have zero, one, or several memberships.
_Avoid_: Parent, path

**Group lens**:
The single active same-page view used to browse All members, Ungrouped members,
or the members of one Label group or Session group.
_Avoid_: Group page, folder route

**Ungrouped**:
The projected set of Labels or Named Sessions with no organization membership.
It is a system lens, not a user-created group.
