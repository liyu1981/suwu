/**
 * Git Graph Renderer
 * Adapted from vscode-git-graph (MIT License)
 * Original: https://github.com/mhutchie/vscode-git-graph
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface GraphLine {
  readonly p1: Point;
  readonly p2: Point;
  readonly lockedFirst: boolean;
}

export interface PlacedLine {
  readonly p1: { x: number; y: number };
  readonly p2: { x: number; y: number };
  readonly isCommitted: boolean;
  readonly lockedFirst: boolean;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  date: number;
  message: string;
  heads: string[];
  tags: { name: string; annotated: boolean }[];
  remotes: { name: string; remote: string | null }[];
  stash: { selector: string; baseHash: string } | null;
}

export interface GraphConfig {
  style: 'angular' | 'curved';
  colors: string[];
  grid: {
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    expandY: number;
  };
  uncommittedChanges: 'OpenCircleAtTheUncommittedChanges' | 'OpenCircleAtTheCheckedOutCommit';
}

export interface MuteConfig {
  mergeCommits: boolean;
  commitsNotAncestorsOfHead: boolean;
}

export interface GraphNode {
  id: number;
  hash: string;
  x: number;
  y: number;
  color: string;
  isCurrent: boolean;
  isStash: boolean;
  isCommitted: boolean;
}

export interface GraphEdge {
  path: string;
  color: string;
  isCommitted: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const NULL_VERTEX_ID = -1;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/* Branch Class */
class Branch {
  private readonly colour: number;
  private end: number = 0;
  private lines: GraphLine[] = [];
  private numUncommitted: number = 0;

  constructor(colour: number) {
    this.colour = colour;
  }

  public addLine(p1: Point, p2: Point, isCommitted: boolean, lockedFirst: boolean) {
    this.lines.push({ p1, p2, lockedFirst });
    if (isCommitted) {
      if (p2.x === 0 && p2.y < this.numUncommitted) this.numUncommitted = p2.y;
    } else {
      this.numUncommitted++;
    }
  }

  public getColour() { return this.colour; }
  public getEnd() { return this.end; }
  public setEnd(end: number) { this.end = end; }
  public getLines() { return this.lines; }
  public getNumUncommitted() { return this.numUncommitted; }

  /**
   * Generate SVG paths for this branch
   */
  public generatePaths(config: GraphConfig, expandAt: number): { path: string; isCommitted: boolean }[] {
    const colour = config.colors[this.colour % config.colors.length];
    const lines: PlacedLine[] = [];
    const d = config.grid.y * (config.style === 'angular' ? 0.38 : 0.8);

    // Convert branch lines into pixel coordinates
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      let x1 = line.p1.x * config.grid.x + config.grid.offsetX;
      let y1 = line.p1.y * config.grid.y + config.grid.offsetY;
      let x2 = line.p2.x * config.grid.x + config.grid.offsetX;
      let y2 = line.p2.y * config.grid.y + config.grid.offsetY;

      // Handle expanded commit
      if (expandAt > -1) {
        if (line.p1.y > expandAt) {
          y1 += config.grid.expandY;
          y2 += config.grid.expandY;
        } else if (line.p2.y > expandAt) {
          if (x1 === x2) {
            y2 += config.grid.expandY;
          } else if (line.lockedFirst) {
            lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst });
            lines.push({ p1: { x: x2, y: y1 + config.grid.y }, p2: { x: x2, y: y2 + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst });
            continue;
          } else {
            lines.push({ p1: { x: x1, y: y1 }, p2: { x: x1, y: y2 - config.grid.y + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst });
            y1 += config.grid.expandY;
            y2 += config.grid.expandY;
          }
        }
      }
      lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst });
    }

    // Simplify consecutive straight lines
    let i = 0;
    while (i < lines.length - 1) {
      const line = lines[i];
      const nextLine = lines[i + 1];
      if (line.p1.x === line.p2.x && line.p2.x === nextLine.p1.x && nextLine.p1.x === nextLine.p2.x && line.p2.y === nextLine.p1.y && line.isCommitted === nextLine.isCommitted) {
        lines[i] = { ...line, p2: nextLine.p2 };
        lines.splice(i + 1, 1);
      } else {
        i++;
      }
    }

    // Generate SVG paths
    const paths: { path: string; isCommitted: boolean }[] = [];
    let curPath = '';

    for (i = 0; i < lines.length; i++) {
      const line = lines[i];
      const x1 = line.p1.x;
      const y1 = line.p1.y;
      const x2 = line.p2.x;
      const y2 = line.p2.y;

      // If the new point belongs to a different path, save current path
      if (curPath !== '' && i > 0 && line.isCommitted !== lines[i - 1].isCommitted) {
        paths.push({ path: curPath, isCommitted: lines[i - 1].isCommitted });
        curPath = '';
      }

      // Start new path if needed
      if (curPath === '' || (i > 0 && (x1 !== lines[i - 1].p2.x || y1 !== lines[i - 1].p2.y))) {
        curPath += `M${x1.toFixed(0)},${y1.toFixed(1)}`;
      }

      if (x1 === x2) {
        // Vertical line
        curPath += `L${x2.toFixed(0)},${y2.toFixed(1)}`;
      } else {
        // Horizontal transition
        if (config.style === 'angular') {
          curPath += `L${(line.lockedFirst ? x2.toFixed(0) : x1.toFixed(0))},${(line.lockedFirst ? (y2 - d).toFixed(1) : (y1 + d).toFixed(1))}L${x2.toFixed(0)},${y2.toFixed(1)}`;
        } else {
          curPath += `C${x1.toFixed(0)},${(y1 + d).toFixed(1)} ${x2.toFixed(0)},${(y2 - d).toFixed(1)} ${x2.toFixed(0)},${y2.toFixed(1)}`;
        }
      }
    }

    if (curPath !== '') {
      paths.push({ path: curPath, isCommitted: lines.length > 0 ? lines[lines.length - 1].isCommitted : true });
    }

    return paths;
  }
}

/* Vertex Class */
class Vertex {
  public readonly id: number;
  public readonly isStash: boolean;

  private x: number = 0;
  private children: Vertex[] = [];
  private parents: Vertex[] = [];
  private nextParent: number = 0;
  private onBranch: Branch | null = null;
  private isCommitted: boolean = true;
  private isCurrent: boolean = false;
  private nextX: number = 0;
  private connections: { connectsTo: Vertex | null; onBranch: Branch }[] = [];

  constructor(id: number, isStash: boolean) {
    this.id = id;
    this.isStash = isStash;
  }

  public addChild(vertex: Vertex) { this.children.push(vertex); }
  public getChildren(): Vertex[] { return this.children; }
  public addParent(vertex: Vertex) { this.parents.push(vertex); }
  public getParents(): Vertex[] { return this.parents; }
  public hasParents() { return this.parents.length > 0; }

  public getNextParent(): Vertex | null {
    return this.nextParent < this.parents.length ? this.parents[this.nextParent] : null;
  }

  public registerParentProcessed() { this.nextParent++; }
  public isMerge() { return this.parents.length > 1; }

  public addToBranch(branch: Branch, x: number) {
    if (this.onBranch === null) {
      this.onBranch = branch;
      this.x = x;
    }
  }

  public isNotOnBranch() { return this.onBranch === null; }
  public isOnThisBranch(branch: Branch) { return this.onBranch === branch; }
  public getBranch() { return this.onBranch; }

  public getPoint(): Point { return { x: this.x, y: this.id }; }
  public getNextPoint(): Point { return { x: this.nextX, y: this.id }; }

  public getPointConnectingTo(vertex: Vertex | null, onBranch: Branch): Point | null {
    for (let i = 0; i < this.connections.length; i++) {
      if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
        return { x: i, y: this.id };
      }
    }
    return null;
  }

  public registerUnavailablePoint(x: number, connectsToVertex: Vertex | null, onBranch: Branch) {
    if (x === this.nextX) {
      this.nextX = x + 1;
      this.connections[x] = { connectsTo: connectsToVertex, onBranch };
    }
  }

  public getColour() { return this.onBranch !== null ? this.onBranch.getColour() : 0; }
  public getIsCommitted() { return this.isCommitted; }
  public setNotCommitted() { this.isCommitted = false; }
  public setCurrent() { this.isCurrent = true; }
  public isCurrentVertex() { return this.isCurrent; }
}

/* Graph Class */
export class Graph {
  private config: GraphConfig;
  private muteConfig: MuteConfig;
  private vertices: Vertex[] = [];
  private branches: Branch[] = [];
  private availableColours: number[] = [];

  private commits: GitCommit[] = [];
  private commitHead: string | null = null;
  private commitLookup: { [hash: string]: number } = {};
  private onlyFollowFirstParent: boolean = false;
  private expandedCommitIndex: number = -1;

  constructor(config: GraphConfig, muteConfig: MuteConfig) {
    this.config = config;
    this.muteConfig = muteConfig;
  }

  /**
   * Load commits and build the graph structure
   */
  public loadCommits(
    commits: GitCommit[],
    commitHead: string | null,
    commitLookup: { [hash: string]: number },
    onlyFollowFirstParent: boolean
  ) {
    this.commits = commits;
    this.commitHead = commitHead;
    this.commitLookup = commitLookup;
    this.onlyFollowFirstParent = onlyFollowFirstParent;
    this.vertices = [];
    this.branches = [];
    this.availableColours = [];

    if (commits.length === 0) return;

    const nullVertex = new Vertex(NULL_VERTEX_ID, false);

    // Create vertices
    for (let i = 0; i < commits.length; i++) {
      this.vertices.push(new Vertex(i, commits[i].stash !== null));
    }

    // Build parent-child relationships
    for (let i = 0; i < commits.length; i++) {
      for (let j = 0; j < commits[i].parents.length; j++) {
        const parentHash = commits[i].parents[j];
        if (typeof commitLookup[parentHash] === 'number') {
          this.vertices[i].addParent(this.vertices[commitLookup[parentHash]]);
          this.vertices[commitLookup[parentHash]].addChild(this.vertices[i]);
        } else if (!this.onlyFollowFirstParent || j === 0) {
          this.vertices[i].addParent(nullVertex);
        }
      }
    }

    // Mark uncommitted
    if (commits[0].hash === 'UNCOMMITTED') {
      this.vertices[0].setNotCommitted();
    }

    // Mark current HEAD
    if (commits[0].hash === 'UNCOMMITTED' && this.config.uncommittedChanges === 'OpenCircleAtTheUncommittedChanges') {
      this.vertices[0].setCurrent();
    } else if (commitHead !== null && typeof commitLookup[commitHead] === 'number') {
      this.vertices[commitLookup[commitHead]].setCurrent();
    }

    // Determine paths
    let i = 0;
    while (i < this.vertices.length) {
      if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
        this.determinePath(i);
      } else {
        i++;
      }
    }
  }

  /**
   * Generate graph layout data
   */
  public generateLayout(expandedCommitIndex: number = -1): GraphLayout {
    this.expandedCommitIndex = expandedCommitIndex;

    // Generate edges
    const edges: GraphEdge[] = [];
    for (const branch of this.branches) {
      const paths = branch.generatePaths(this.config, expandedCommitIndex);
      const color = this.config.colors[branch.getColour() % this.config.colors.length];

      for (const p of paths) {
        edges.push({
          path: p.path,
          color: p.isCommitted ? color : '#808080',
          isCommitted: p.isCommitted,
        });
      }
    }

    // Generate nodes
    const nodes: GraphNode[] = [];
    for (const vertex of this.vertices) {
      if (vertex.getBranch() === null) continue;

      const point = vertex.getPoint();
      const color = vertex.getIsCommitted()
        ? this.config.colors[vertex.getColour() % this.config.colors.length]
        : '#808080';

      nodes.push({
        id: vertex.id,
        hash: this.commits[vertex.id]?.hash || '',
        x: point.x * this.config.grid.x + this.config.grid.offsetX,
        y: point.y * this.config.grid.y + this.config.grid.offsetY + (expandedCommitIndex > -1 && vertex.id > expandedCommitIndex ? this.config.grid.expandY : 0),
        color,
        isCurrent: vertex.isCurrentVertex(),
        isStash: vertex.isStash,
        isCommitted: vertex.getIsCommitted(),
      });
    }

    return {
      nodes,
      edges,
      width: this.getContentWidth(),
      height: this.getHeight(expandedCommitIndex),
    };
  }

  /**
   * Get all children of a vertex (for tooltips)
   */
  public getAllChildren(vertexId: number): number[] {
    const visited: { [id: string]: number } = {};

    const rec = (vertex: Vertex) => {
      const idStr = vertex.id.toString();
      if (typeof visited[idStr] !== 'undefined') return;
      visited[idStr] = vertex.id;

      for (const child of vertex.getChildren()) {
        rec(child);
      }
    };

    rec(this.vertices[vertexId]);
    return Object.keys(visited).map((key) => visited[key]).sort((a, b) => a - b);
  }

  /**
   * Get muted commits (for dimming)
   */
  public getMutedCommits(currentHash: string | null): boolean[] {
    const muted: boolean[] = new Array(this.commits.length).fill(false);

    // Mute merge commits if configured
    if (this.muteConfig.mergeCommits) {
      for (let i = 0; i < this.commits.length; i++) {
        if (this.vertices[i].isMerge() && this.commits[i].stash === null) {
          muted[i] = true;
        }
      }
    }

    // Mute commits not ancestors of HEAD
    if (this.muteConfig.commitsNotAncestorsOfHead && currentHash !== null && typeof this.commitLookup[currentHash] === 'number') {
      const ancestor: boolean[] = new Array(this.commits.length).fill(false);

      const rec = (vertex: Vertex) => {
        if (vertex.id === NULL_VERTEX_ID || ancestor[vertex.id]) return;
        ancestor[vertex.id] = true;
        for (const parent of vertex.getParents()) rec(parent);
      };

      rec(this.vertices[this.commitLookup[currentHash]]);

      for (let i = 0; i < this.commits.length; i++) {
        if (!ancestor[i]) {
          muted[i] = true;
        }
      }
    }

    return muted;
  }

  /* Private methods */

  private getContentWidth(): number {
    let x = 0;
    for (const vertex of this.vertices) {
      const p = vertex.getNextPoint();
      if (p.x > x) x = p.x;
    }
    return 2 * this.config.grid.offsetX + (x - 1) * this.config.grid.x;
  }

  private getHeight(expandedCommit: number): number {
    return this.vertices.length * this.config.grid.y + this.config.grid.offsetY - this.config.grid.y / 2 + (expandedCommit > -1 ? this.config.grid.expandY : 0);
  }

  private determinePath(startAt: number) {
    let i = startAt;
    let vertex = this.vertices[i];
    let parentVertex = vertex.getNextParent();
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();

    if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
      // Merge between two vertices already on branches
      let foundPointToParent = false;
      const parentBranch = parentVertex.getBranch()!;

      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        let curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);

        if (curPoint !== null) {
          foundPointToParent = true;
        } else {
          curPoint = curVertex.getNextPoint();
        }

        parentBranch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
        lastPoint = curPoint;

        if (foundPointToParent) {
          vertex.registerParentProcessed();
          break;
        }
      }
    } else {
      // Normal branch
      const branch = new Branch(this.getAvailableColour(startAt));
      vertex.addToBranch(branch, lastPoint.x);
      vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);

      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        const curPoint = parentVertex === curVertex && !parentVertex.isNotOnBranch() ? curVertex.getPoint() : curVertex.getNextPoint();

        branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
        lastPoint = curPoint;

        if (parentVertex === curVertex) {
          vertex.registerParentProcessed();
          const parentVertexOnBranch = !parentVertex.isNotOnBranch();
          parentVertex.addToBranch(branch, curPoint.x);
          vertex = parentVertex;
          parentVertex = vertex.getNextParent();

          if (parentVertex === null || parentVertexOnBranch) {
            break;
          }
        }
      }

      if (i === this.vertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
        vertex.registerParentProcessed();
      }

      branch.setEnd(i);
      this.branches.push(branch);
      this.availableColours[branch.getColour()] = i;
    }
  }

  private getAvailableColour(startAt: number): number {
    for (let i = 0; i < this.availableColours.length; i++) {
      if (startAt > this.availableColours[i]) {
        return i;
      }
    }
    this.availableColours.push(0);
    return this.availableColours.length - 1;
  }
}

/**
 * Create a graph and generate layout from commits
 */
export function createGraphLayout(
  commits: GitCommit[],
  config: GraphConfig,
  muteConfig: MuteConfig,
  options: {
    commitHead?: string | null;
    onlyFollowFirstParent?: boolean;
    expandedCommitIndex?: number;
  } = {}
): GraphLayout {
  const graph = new Graph(config, muteConfig);

  // Build commit lookup
  const commitLookup: { [hash: string]: number } = {};
  commits.forEach((commit, index) => {
    commitLookup[commit.hash] = index;
  });

  graph.loadCommits(
    commits,
    options.commitHead ?? null,
    commitLookup,
    options.onlyFollowFirstParent ?? false
  );

  return graph.generateLayout(options.expandedCommitIndex ?? -1);
}
