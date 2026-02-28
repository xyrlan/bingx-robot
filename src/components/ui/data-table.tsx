'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type RowSelectionState,
  type PaginationState,
  type OnChangeFn,
  type Table,
  type Header,
  type Row,
} from '@tanstack/react-table';
import { Button, Checkbox } from '@heroui/react';
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  X,
  Filter,
} from 'lucide-react';

// ============================================
// Types
// ============================================

export interface FacetedFilterOption {
  label: string;
  value: string;
  icon?: React.ReactNode;
}

export interface FacetedFilterDef {
  /** Must match a column accessor id */
  columnId: string;
  /** Label displayed next to the filter chips */
  title: string;
  /** Available discrete values to filter by */
  options: FacetedFilterOption[];
}

export interface DataTableProps<TData> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<TData, any>[];
  data: TData[];
  searchPlaceholder?: string;
  enableRowSelection?: boolean;
  isLoading?: boolean;
  /** Clickable faceted filters rendered in the toolbar */
  facetedFilters?: FacetedFilterDef[];
  /** Controlled server-side pagination */
  pageCount?: number;
  manualPagination?: boolean;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  /** Callback when row selection changes */
  onRowSelectionChange?: (selectedRows: TData[]) => void;
}

/**
 * Custom filter function for faceted filters.
 * The column filter value is an array of selected options.
 * A row passes if its cell value is included in the array.
 */
export const facetedFilterFn = <TData,>(row: Row<TData>, columnId: string, filterValue: string[]) => {
  if (!filterValue || filterValue.length === 0) return true;
  const cellValue = String(row.getValue(columnId));
  return filterValue.includes(cellValue);
};

// ============================================
// Selection Column Helper
// ============================================

export function getSelectionColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: 'select',
    header: ({ table }: { table: Table<TData> }) => (
      <DataTableSelectAllCheckbox table={table} />
    ),
    cell: ({ row }: { row: Row<TData> }) => (
      <DataTableRowCheckbox row={row} />
    ),
    enableSorting: false,
    enableHiding: false,
    size: 40,
  };
}

// ============================================
// Sub-components
// ============================================

function DataTableSelectAllCheckbox<TData>({ table }: { table: Table<TData> }) {
  const isAllSelected = table.getIsAllPageRowsSelected();
  const isSomeSelected = table.getIsSomePageRowsSelected();

  return (
    <Checkbox
      isSelected={isAllSelected}
      isIndeterminate={isSomeSelected && !isAllSelected}
      onChange={() => table.toggleAllPageRowsSelected(!isAllSelected)}
      aria-label="Select all"
    >
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
    </Checkbox>
  );
}

function DataTableRowCheckbox<TData>({ row }: { row: Row<TData> }) {
  return (
    <Checkbox
      isSelected={row.getIsSelected()}
      isDisabled={!row.getCanSelect()}
      onChange={() => row.toggleSelected()}
      aria-label="Select row"
    >
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
    </Checkbox>
  );
}

function DataTableColumnHeader<TData>({
  header,
}: {
  header: Header<TData, unknown>;
}) {
  const canSort = header.column.getCanSort();
  const sortDirection = header.column.getIsSorted();

  if (!canSort) {
    return (
      <span>
        {flexRender(header.column.columnDef.header, header.getContext())}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="flex items-center gap-1.5 hover:text-foreground transition-colors cursor-pointer select-none"
      onClick={header.column.getToggleSortingHandler()}
    >
      {flexRender(header.column.columnDef.header, header.getContext())}
      {sortDirection === 'asc' ? (
        <ArrowUp className="size-3.5" />
      ) : sortDirection === 'desc' ? (
        <ArrowDown className="size-3.5" />
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

function DataTableSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative w-full max-w-sm">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Buscar...'}
        className="w-full rounded-lg border border-default-200 bg-default-50 py-2 pl-9 pr-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
      />
    </div>
  );
}

function DataTableFilterDropdown<TData>({
  table,
  filters,
}: {
  table: Table<TData>;
  filters: FacetedFilterDef[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  // Count total active filters across all faceted filter groups
  const activeCount = filters.reduce((acc, filter) => {
    const col = table.getColumn(filter.columnId);
    const val = (col?.getFilterValue() as string[] | undefined) ?? [];
    return acc + val.length;
  }, 0);

  function toggleValue(columnId: string, value: string) {
    const column = table.getColumn(columnId);
    if (!column) return;
    const current = new Set((column.getFilterValue() as string[] | undefined) ?? []);
    if (current.has(value)) {
      current.delete(value);
    } else {
      current.add(value);
    }
    const next = Array.from(current);
    column.setFilterValue(next.length > 0 ? next : undefined);
  }

  function clearAll() {
    for (const filter of filters) {
      table.getColumn(filter.columnId)?.setFilterValue(undefined);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors cursor-pointer select-none ${
          activeCount > 0
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-default-200 bg-default-50 text-muted hover:bg-default-100 hover:text-foreground'
        }`}
      >
        <Filter className="size-4" />
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center size-5 rounded-full bg-accent text-accent-foreground text-[10px] font-bold">
            {activeCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown panel */}
          <div className="absolute right-0 top-full mt-2 z-50 min-w-[280px] rounded-xl border border-default-200 bg-background shadow-lg p-4 space-y-4">
            {filters.map((filter) => {
              const column = table.getColumn(filter.columnId);
              const selectedValues = (column?.getFilterValue() as string[] | undefined) ?? [];

              return (
                <div key={filter.columnId} className="space-y-2">
                  <span className="text-xs font-semibold tracking-wider text-muted">
                    {filter.title}
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {filter.options.map((option) => {
                      const isActive = selectedValues.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => toggleValue(filter.columnId, option.value)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer select-none border ${
                            isActive
                              ? 'bg-accent text-accent-foreground border-accent'
                              : 'bg-background text-muted border-default-200 hover:bg-default-100 hover:text-foreground'
                          }`}
                        >
                          {option.icon}
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Clear all button */}
            {activeCount > 0 && (
              <div className="pt-2 border-t border-default-200">
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground transition-colors cursor-pointer"
                >
                  <X className="size-3" />
                  Limpar filtros
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DataTablePagination<TData>({ table }: { table: Table<TData> }) {
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const selectedCount = table.getFilteredSelectedRowModel().rows.length;
  const totalRows = table.getFilteredRowModel().rows.length;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-2 py-4">
      {/* Selection info */}
      <div className="text-sm text-muted">
        {selectedCount > 0 ? (
          <span>
            {selectedCount} de {totalRows} selecionado(s)
          </span>
        ) : (
          <span>{totalRows} resultado(s)</span>
        )}
      </div>

      {/* Pagination controls */}
      <div className="flex items-center gap-2">
        {/* Page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">Linhas:</span>
          <select
            value={table.getState().pagination.pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
            className="rounded-md border border-default-200 bg-default-50 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            {[10, 20, 30, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        {/* Page indicator */}
        <span className="text-sm text-muted min-w-[100px] text-center">
          Pag. {pageIndex + 1} de {pageCount || 1}
        </span>

        {/* Navigation buttons */}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            isDisabled={!table.getCanPreviousPage()}
            onPress={() => table.setPageIndex(0)}
            aria-label="First page"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            isDisabled={!table.getCanPreviousPage()}
            onPress={() => table.previousPage()}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            isDisabled={!table.getCanNextPage()}
            onPress={() => table.nextPage()}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            isDisabled={!table.getCanNextPage()}
            onPress={() => table.setPageIndex(table.getPageCount() - 1)}
            aria-label="Last page"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function DataTableSkeleton({ columnCount }: { columnCount: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, rowIdx) => (
        <tr key={rowIdx} className="border-b border-default-100">
          {Array.from({ length: columnCount }).map((_, colIdx) => (
            <td key={colIdx} className="px-4 py-3">
              <div className="h-4 w-3/4 animate-pulse rounded bg-default-200" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ============================================
// Main DataTable Component
// ============================================

export function DataTable<TData>({
  columns,
  data,
  searchPlaceholder,
  enableRowSelection = false,
  isLoading = false,
  facetedFilters,
  pageCount: controlledPageCount,
  manualPagination = false,
  pagination: controlledPagination,
  onPaginationChange,
  onRowSelectionChange,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [internalPagination, setInternalPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  const pagination = controlledPagination ?? internalPagination;
  const setPagination = onPaginationChange ?? setInternalPagination;

  // Build columns with selection if enabled
  const allColumns = useMemo(() => {
    if (enableRowSelection) {
      return [getSelectionColumn<TData>(), ...columns];
    }
    return columns;
  }, [columns, enableRowSelection]);

  const handleRowSelectionChange: OnChangeFn<RowSelectionState> = useCallback(
    (updater) => {
      setRowSelection(updater);
    },
    [],
  );

  const table = useReactTable({
    data,
    columns: allColumns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      rowSelection,
      pagination,
    },
    enableRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: handleRowSelectionChange,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    ...(manualPagination && {
      manualPagination: true,
      pageCount: controlledPageCount ?? -1,
    }),
  });

  // Notify parent of selection changes
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  useMemo(() => {
    if (onRowSelectionChange) {
      onRowSelectionChange(selectedRows.map((row) => row.original));
    }
  }, [selectedRows, onRowSelectionChange]);

  return (
    <div className="w-full space-y-4">
      {/* Toolbar: Search + Filter button */}
      <div className="flex items-center gap-2">
        <DataTableSearch
          value={globalFilter}
          onChange={setGlobalFilter}
          placeholder={searchPlaceholder}
        />
        {facetedFilters && facetedFilters.length > 0 && (
          <DataTableFilterDropdown
            table={table}
            filters={facetedFilters}
          />
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-default-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-default-100">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-muted"
                      style={{
                        width: header.getSize() !== 150 ? header.getSize() : undefined,
                      }}
                    >
                      {header.isPlaceholder ? null : (
                        <DataTableColumnHeader header={header} />
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-default-100">
              {isLoading ? (
                <DataTableSkeleton columnCount={allColumns.length} />
              ) : table.getRowModel().rows.length > 0 ? (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`transition-colors hover:bg-default-50 ${
                      row.getIsSelected() ? 'bg-accent/5' : ''
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={allColumns.length}
                    className="px-4 py-12 text-center text-muted"
                  >
                    Nenhum resultado encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <DataTablePagination table={table} />
    </div>
  );
}
