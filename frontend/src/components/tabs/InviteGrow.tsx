'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../ui';
import QrCode from '../QrCode';
import type { InviteView, TreeNode, TreeView } from '../../types';

/**
 * Invite & grow (PRD-growth FR-O2 + FR-O4) — a member's / ward councillor's own
 * recruitment surface, reachable from Home and the More hub.
 *
 * It shows the reference number that attributes every member they sign up, a
 * shareable join link + QR (so a councillor can register someone from their
 * phone and the recruit is credited to them), and their own recruitment tree —
 * the "leaves" view of who they brought in and who those members brought in.
 *
 * PRIVACY (AC-O2): the tree speaks in public reference codes, tiers, wards,
 * join dates and counts only — never names, emails or phone numbers. The one
 * human name that can appear is a PUBLIC ward-councillor `displayName` the
 * transparency directory already publishes.
 */

/** Best public label for a node — councillor name, else the reference code. */
function nodeLabel(n: TreeNode): string {
  return n.displayName ?? n.publicCode ?? `${n.memberId.slice(0, 8)}…`;
}

export default function InviteGrow() {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTree, setShowTree] = useState(false);
  const [tree, setTree] = useState<TreeView | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getInvite()
      .then((r) => {
        if (cancelled) return;
        setInvite(r);
        setError(null);
      })
      .catch((e: { message?: string }) => !cancelled && setError(e?.message ?? 'Could not load your invite details.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showTree) return;
    let cancelled = false;
    setTreeLoading(true);
    api
      .getRecruitmentTree({ depth: 8 })
      .then((t) => !cancelled && setTree(t))
      .catch(() => !cancelled && setTree(null))
      .finally(() => !cancelled && setTreeLoading(false));
    return () => {
      cancelled = true;
    };
  }, [showTree]);

  if (loading) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="card">
        <div className="mini-label">Invite &amp; grow</div>
        <p className="hint-text">{error ?? 'Your invite details are not available yet.'}</p>
        <p className="hint-text" style={{ marginTop: 8 }}>
          A reference number is issued once your member profile is linked to your login. If you have just registered,
          this appears as soon as your account is activated.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card hero-card">
        <span className="eyebrow">Your reference number</span>
        <h2>{invite.publicCode}</h2>
        <p>{invite.referredBy ? `Referred by ${invite.referredBy}` : 'You are a founding root of your branch'}</p>
      </div>

      <div className="stat-grid">
        <div className="stat accent">
          <div className="num">{invite.directReferrals}</div>
          <div className="lbl">Signed up by you</div>
        </div>
        <div className="stat">
          <div className="num">{invite.downline}</div>
          <div className="lbl">Total in your tree</div>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center' }}>
        <div className="mini-label">Scan to join with your reference</div>
        <QrCode value={invite.joinUrl} size={176} label="Join link QR code" />
      </div>

      <div className="section-label">Your recruitment tree</div>
      <button className="btn btn-ghost btn-block" onClick={() => setShowTree((s) => !s)}>
        <Icon name="users" size={16} /> {showTree ? 'Hide tree' : 'View who I brought in'}
      </button>

      {showTree &&
        (treeLoading ? (
          <div className="card">
            <div className="skeleton" style={{ height: 80 }} />
          </div>
        ) : tree && tree.nodes.length > 1 ? (
          <div className="card">
            {tree.truncated && (
              <p className="hint-text" style={{ marginTop: 0 }}>
                Showing the first {tree.depthCap} levels · {tree.totalNodes} members below you.
              </p>
            )}
            {renderTree(tree.nodes)}
          </div>
        ) : (
          <div className="card">
            <p className="hint-text" style={{ margin: 0 }}>
              No one has joined with your reference yet. Share your link or QR to grow your branch.
            </p>
          </div>
        ))}

      <p className="hint-text" style={{ marginTop: 14 }}>
        Privacy: your tree shows reference codes and counts only — never names, emails or phone numbers.
      </p>
      <div style={{ height: 12 }} />
    </>
  );
}

/**
 * Render the flat, depth-ordered node list as an indented tree (FR-O4). Children
 * nest under their `parentId`; the root (depth 0) is the caller.
 */
function renderTree(nodes: TreeNode[]): ReactNode {
  const byParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (n.parentId) {
      const list = byParent.get(n.parentId) ?? [];
      list.push(n);
      byParent.set(n.parentId, list);
    }
  }
  const roots = nodes.filter((n) => n.depth === 0);

  const walk = (node: TreeNode): ReactNode => {
    const kids = byParent.get(node.memberId) ?? [];
    return (
      <div key={node.memberId}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 0',
            borderBottom: '1px solid rgba(0,0,0,0.05)',
          }}
        >
          <Icon name={node.depth === 0 ? 'flag' : 'users'} size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: node.depth === 0 ? 700 : 600, fontSize: 14 }}>{nodeLabel(node)}</div>
            <div className="row-sub tiny">
              {node.tier}
              {node.ward ? ` · ${node.ward}` : ''} · {node.directReferrals} direct · {node.downline} downline
            </div>
          </div>
          <span className={`dot ${node.status === 'active' ? 'ok' : node.status === 'pending' ? 'mute' : 'danger'}`} />
        </div>
        {kids.length > 0 && (
          <div style={{ marginLeft: 14, paddingLeft: 10, borderLeft: '2px solid rgba(0,0,0,0.06)' }}>
            {kids.map(walk)}
          </div>
        )}
      </div>
    );
  };

  return <div>{roots.map(walk)}</div>;
}
