import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

// Stamp each body cell with its column header so CSS can show "OpenReview: …" labels when
// the table stacks into cards. Thead stays a real header row for desktop screen readers.

type CellProps = { children?: ReactNode; "data-label"?: string };
type NodeProps = { children?: ReactNode };

const cellText = (node: ReactNode): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(cellText).join("");
  if (isValidElement<NodeProps>(node)) return cellText(node.props.children);
  return "";
};

const isTag = <P extends NodeProps>(node: ReactNode, tag: string): node is ReactElement<P> =>
  isValidElement<P>(node) && node.type === tag;

function headersFrom(children: ReactNode): string[] {
  const headers: string[] = [];
  const takeRow = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (isTag<NodeProps>(child, "tr")) {
        Children.forEach(child.props.children, (cell) => {
          if (isTag<CellProps>(cell, "th") || isTag<CellProps>(cell, "td")) {
            headers.push(cellText(cell.props.children).replace(/\s+/g, " ").trim());
          }
        });
      } else if (isValidElement<NodeProps>(child)) takeRow(child.props.children);
    });
  };
  Children.forEach(children, (child) => {
    if (isTag<NodeProps>(child, "thead")) takeRow(child.props.children);
  });
  return headers;
}

function labelRows(node: ReactNode, headers: string[]): ReactNode {
  return Children.map(node, (child) => {
    if (isTag<NodeProps>(child, "thead")) return child;
    if (isTag<NodeProps>(child, "tr")) {
      let i = 0;
      return cloneElement(child, undefined, Children.map(child.props.children, (cell) => {
        if (!isTag<CellProps>(cell, "td") && !isTag<CellProps>(cell, "th")) return cell;
        return cloneElement(cell, { "data-label": headers[i++] ?? "" });
      }));
    }
    if (isValidElement<NodeProps>(child)) return cloneElement(child, undefined, labelRows(child.props.children, headers));
    return child;
  });
}

export function CompareTable({ children }: { children: ReactNode }) {
  return <table className="compare-table">{labelRows(children, headersFrom(children))}</table>;
}
