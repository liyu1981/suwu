/**
 * Git Graph SVG Renderer Component
 * Adapted from vscode-git-graph (MIT License)
 */

import { useMemo, useState, useEffect } from 'react';
import type { GraphConfig, MuteConfig, GitCommit } from './graph';
import { createGraphLayout } from './graph';

interface GraphRendererProps {
  commits: GitCommit[];
  config?: GraphConfig;
  muteConfig?: MuteConfig;
  commitHead?: string | null;
  expandedCommitIndex?: number;
  onCommitClick?: (commit: GitCommit, index: number) => void;
  onCommitHover?: (commit: GitCommit | null, index: number | null) => void;
}

const DEFAULT_CONFIG: GraphConfig = {
  style: 'curved',
  colors: [
    '#0366d6', '#6f42c1', '#e36209', '#00875a', '#5067d6',
    '#f97583', '#79b8ff', '#b392f0', '#f9826c', '#85e89d',
    '#56d4dd', '#da3633', '#fdd663', '#0457c0', '#6e40c9',
  ],
  grid: {
    x: 24,
    y: 24,
    offsetX: 12,
    offsetY: 12,
    expandY: 260,
  },
  uncommittedChanges: 'OpenCircleAtTheUncommittedChanges',
};

const DEFAULT_MUTE_CONFIG: MuteConfig = {
  mergeCommits: false,
  commitsNotAncestorsOfHead: false,
};

export function GraphRenderer({
  commits,
  config = DEFAULT_CONFIG,
  muteConfig = DEFAULT_MUTE_CONFIG,
  commitHead = null,
  expandedCommitIndex = -1,
  onCommitClick,
  onCommitHover,
}: GraphRendererProps) {
  const layout = useMemo(() => {
    if (commits.length === 0) return null;
    return createGraphLayout(commits, config, muteConfig, {
      commitHead,
      expandedCommitIndex,
    });
  }, [commits, config, muteConfig, commitHead, expandedCommitIndex]);

  if (!layout) {
    return <svg className="h-full w-full" />;
  }

  return (
    <svg
      className="h-full w-full"
      width={layout.width}
      height={layout.height}
    >
      {/* Branch lines */}
      {layout.edges.map((edge, i) => (
        <GraphEdge
          key={`edge-${i}`}
          path={edge.path}
          color={edge.color}
          isCommitted={edge.isCommitted}
        />
      ))}

      {/* Commit vertices */}
      {layout.nodes.map((node) => (
        <GraphVertex
          key={`node-${node.id}`}
          node={node}
          commit={commits[node.id]}
          onClick={onCommitClick}
          onHover={onCommitHover}
        />
      ))}
    </svg>
  );
}

/* GraphEdge Component */
interface GraphEdgeProps {
  path: string;
  color: string;
  isCommitted: boolean;
}

function GraphEdge({ path, color, isCommitted }: GraphEdgeProps) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    // Trigger animation on mount
    requestAnimationFrame(() => setAnimate(true));
  }, []);

  return (
    <g
      style={{
        opacity: animate ? 1 : 0,
        transition: 'opacity 0.3s ease-out',
      }}
    >
      {/* Shadow */}
      <path
        d={path}
        className="stroke-white/10"
        strokeWidth={3}
        fill="none"
        style={{
          strokeDasharray: animate ? 'none' : '1000',
          strokeDashoffset: animate ? '0' : '1000',
          transition: 'stroke-dashoffset 0.4s ease-out',
        }}
      />
      {/* Main line */}
      <path
        d={path}
        stroke={color}
        strokeWidth={2}
        fill="none"
        strokeDasharray={isCommitted ? undefined : '2px 2px'}
        style={{
          strokeDasharray: animate ? (isCommitted ? 'none' : '2px 2px') : '1000',
          strokeDashoffset: animate ? '0' : '1000',
          transition: 'stroke-dashoffset 0.4s ease-out',
        }}
      />
    </g>
  );
}

/* GraphVertex Component */
interface GraphVertexProps {
  node: {
    id: number;
    hash: string;
    x: number;
    y: number;
    color: string;
    isCurrent: boolean;
    isStash: boolean;
    isCommitted: boolean;
  };
  commit: GitCommit | undefined;
  onClick?: (commit: GitCommit, index: number) => void;
  onHover?: (commit: GitCommit | null, index: number | null) => void;
}

function GraphVertex({ node, commit, onClick, onHover }: GraphVertexProps) {
  const [animate, setAnimate] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    // Stagger animation based on node id
    const timer = setTimeout(() => {
      requestAnimationFrame(() => setAnimate(true));
    }, Math.min(node.id * 10, 300));
    return () => clearTimeout(timer);
  }, [node.id]);

  const handleClick = () => {
    if (commit && onClick) {
      onClick(commit, node.id);
    }
  };

  const handleMouseEnter = () => {
    setHovered(true);
    if (commit && onHover) {
      onHover(commit, node.id);
    }
  };

  const handleMouseLeave = () => {
    setHovered(false);
    if (onHover) {
      onHover(null, null);
    }
  };

  const radius = node.isStash ? 4.5 : 4;
  const scale = animate ? (hovered ? 1.4 : 1) : 0;

  return (
    <g
      style={{
        transform: `translate(${node.x}px, ${node.y}px) scale(${scale})`,
        transformOrigin: '0 0',
        transition: 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      {/* Current commit ring */}
      {node.isCurrent && (
        <circle
          cx={0}
          cy={0}
          r={radius + 2}
          fill="none"
          stroke={node.color}
          strokeWidth={1}
          style={{
            opacity: animate ? 1 : 0,
            transition: 'opacity 0.3s ease-out 0.1s',
          }}
        />
      )}

      {/* Main circle */}
      <circle
        cx={0}
        cy={0}
        r={radius}
        fill={node.isCurrent ? 'transparent' : node.color}
        stroke={node.isCurrent ? node.color : 'transparent'}
        strokeWidth={node.isCurrent ? 1.5 : 0}
        className="cursor-pointer"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          opacity: animate ? 1 : 0,
          transition: 'opacity 0.2s ease-out',
        }}
      />

      {/* Stash inner circle */}
      {node.isStash && !node.isCurrent && (
        <circle
          cx={0}
          cy={0}
          r={2}
          fill="white"
          style={{
            opacity: animate ? 1 : 0,
            transition: 'opacity 0.2s ease-out 0.1s',
          }}
        />
      )}
    </g>
  );
}

export default GraphRenderer;
