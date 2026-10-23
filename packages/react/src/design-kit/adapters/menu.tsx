'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  Children,
  type ComponentProps,
  cloneElement,
  createContext,
  type HTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from 'react';
import {
  DropdownContent,
  DropdownLabel,
  DropdownSeparator,
  DropdownSub,
  DropdownSubContent,
  DropdownSubTrigger,
  DropdownTrigger,
  DropdownMenu as KitMenu,
} from '../components/ui/dropdown.tsx';
import {
  DropdownContext,
  MenuItem as KitMenuItem,
  type MenuItemRenderOptions,
  useDropdown,
} from '../components/ui/menu-item.tsx';
import { cn } from '../lib/utils.ts';

const Menu = KitMenu;
const MenuSub = DropdownSub;

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <DropdownTrigger data-slot="menu-trigger" {...props} />;
}

function labelText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (
        !isValidElement<{ children?: ReactNode; 'aria-hidden'?: boolean | 'true' | 'false' }>(child)
      )
        return '';
      return child.props['aria-hidden'] === true || child.props['aria-hidden'] === 'true'
        ? ''
        : labelText(child.props.children);
    })
    .join('');
}

type IndexedProps = { index?: number; children?: ReactNode; value?: unknown; checked?: boolean };

// Source rows need their index in the containing popup, including grouped rows.
function indexRows(children: ReactNode) {
  let nextIndex = 0;
  let checkedIndex: number | undefined;
  let hasCheckbox = false;
  const checkedIndices: number[] = [];
  function visit(nodes: ReactNode, radioValue?: unknown): ReactNode {
    return Children.map(nodes, (child) => {
      if (
        !isValidElement<IndexedProps & { defaultValue?: unknown; defaultChecked?: boolean }>(child)
      )
        return child;
      if (child.type === MenuPopup || child.type === MenuSubPopup) return child;
      if (
        child.type === MenuItem ||
        child.type === MenuRadioItem ||
        child.type === MenuCheckboxItem ||
        child.type === MenuSubTrigger
      ) {
        const index = nextIndex++;
        if (child.type === MenuRadioItem && child.props.value === radioValue) checkedIndex = index;
        if (child.type === MenuCheckboxItem) {
          hasCheckbox = true;
          if (child.props.checked ?? child.props.defaultChecked) checkedIndices.push(index);
        }
        return cloneElement(child, { index });
      }
      return child.props.children
        ? cloneElement(child, {
            children: visit(
              child.props.children,
              child.type === MenuRadioGroup
                ? (child.props.value ?? child.props.defaultValue)
                : radioValue,
            ),
          })
        : child;
    });
  }
  const indexed = visit(children);
  return {
    children: indexed,
    checkedIndex,
    checkedIndices: hasCheckbox ? checkedIndices : undefined,
  };
}

type MenuPopupProps = Omit<
  ComponentProps<typeof DropdownContent>,
  'checkedIndex' | 'checkedIndices'
>;

function MenuPopup({ children, ...props }: MenuPopupProps) {
  return <DropdownContent {...props} {...indexRows(children)} />;
}

function MenuSubPopup({ children, ...props }: ComponentProps<typeof DropdownSubContent>) {
  return <DropdownSubContent {...props} {...indexRows(children)} />;
}

function MenuGroup({ className, ...props }: MenuPrimitive.Group.Props) {
  return (
    <MenuPrimitive.Group className={className ?? 'contents'} data-slot="menu-group" {...props} />
  );
}

function sourceRow(element: ReactElement) {
  return element.props as HTMLAttributes<HTMLDivElement>;
}

function Row({
  children,
  label,
  index = 0,
  checked,
  disabled,
  renderRow,
}: {
  children?: ReactNode;
  label?: string;
  index?: number;
  checked?: boolean;
  disabled?: boolean;
  renderRow: (options: MenuItemRenderOptions) => ReactElement;
}) {
  const context = useDropdown();
  return (
    <DropdownContext.Provider value={{ ...context, renderMenuItem: renderRow }}>
      <KitMenuItem
        index={index}
        label={label ?? labelText(children)}
        labelContent={children}
        checked={checked}
        disabled={disabled}
      />
    </DropdownContext.Provider>
  );
}

function MenuItem({
  children,
  label,
  index,
  className,
  inset: _inset,
  density: _density,
  variant: _variant,
  ...props
}: MenuPrimitive.Item.Props & {
  index?: number;
  inset?: boolean;
  density?: 'default' | 'touch';
  variant?: 'default' | 'destructive' | 'ghost';
}) {
  return (
    <Row
      label={label}
      index={index}
      disabled={props.disabled}
      renderRow={({ element, children: content, label: text }) => (
        <MenuPrimitive.Item
          {...sourceRow(element)}
          {...props}
          label={text}
          render={props.render ?? element}
          className={(state) =>
            cn(
              sourceRow(element).className,
              typeof className === 'function' ? className(state) : className,
            )
          }
          data-slot="menu-item"
        >
          {content}
        </MenuPrimitive.Item>
      )}
    >
      {children}
    </Row>
  );
}

function MenuItemLabel(props: ComponentProps<'span'>) {
  return <span data-slot="menu-item-label" {...props} />;
}

function MenuCheckboxItem({
  children,
  label,
  index,
  className,
  checked: controlledChecked,
  defaultChecked = false,
  onCheckedChange,
  variant: _variant,
  ...props
}: MenuPrimitive.CheckboxItem.Props & { index?: number; variant?: 'default' | 'switch' }) {
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const checked = controlledChecked ?? internalChecked;
  return (
    <Row
      label={label}
      index={index}
      checked={checked}
      disabled={props.disabled}
      renderRow={({ element, children: content, label: text }) => (
        <MenuPrimitive.CheckboxItem
          {...sourceRow(element)}
          {...props}
          checked={checked}
          onCheckedChange={(next, details) => {
            onCheckedChange?.(next, details);
            if (controlledChecked === undefined && !details.isCanceled) setInternalChecked(next);
          }}
          label={text}
          render={props.render ?? element}
          className={(state) =>
            cn(
              sourceRow(element).className,
              typeof className === 'function' ? className(state) : className,
            )
          }
          data-slot="menu-checkbox-item"
        >
          {content}
        </MenuPrimitive.CheckboxItem>
      )}
    >
      {children}
    </Row>
  );
}

const RadioValueContext = createContext<unknown>(undefined);

function MenuRadioGroup({
  value: controlledValue,
  defaultValue,
  onValueChange,
  children,
  ...props
}: MenuPrimitive.RadioGroup.Props) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = controlledValue === undefined ? internalValue : controlledValue;
  return (
    <RadioValueContext.Provider value={value}>
      <MenuPrimitive.RadioGroup
        {...props}
        value={value}
        onValueChange={(next, details) => {
          onValueChange?.(next, details);
          if (controlledValue === undefined && !details.isCanceled) setInternalValue(next);
        }}
        data-slot="menu-radio-group"
      >
        {children}
      </MenuPrimitive.RadioGroup>
    </RadioValueContext.Provider>
  );
}

function MenuRadioItem({
  children,
  label,
  index,
  className,
  hideIndicator: _hideIndicator,
  ...props
}: MenuPrimitive.RadioItem.Props & { index?: number; hideIndicator?: boolean }) {
  const selected = useContext(RadioValueContext);
  return (
    <Row
      label={label}
      index={index}
      checked={props.value === selected}
      disabled={props.disabled}
      renderRow={({ element, children: content, label: text }) => (
        <MenuPrimitive.RadioItem
          {...sourceRow(element)}
          {...props}
          label={text}
          render={props.render ?? element}
          className={(state) =>
            cn(
              sourceRow(element).className,
              typeof className === 'function' ? className(state) : className,
            )
          }
          data-slot="menu-radio-item"
        >
          {content}
        </MenuPrimitive.RadioItem>
      )}
    >
      {children}
    </Row>
  );
}

const MenuRadioItemIndicator = MenuPrimitive.RadioItemIndicator;

function MenuGroupLabel({
  inset: _inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return <MenuPrimitive.GroupLabel render={<DropdownLabel />} data-slot="menu-label" {...props} />;
}

const MenuSeparator = DropdownSeparator;

function MenuShortcut({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('ms-auto text-micro text-muted-foreground', className)}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSubTrigger({
  children,
  label,
  index = 0,
  inset: _inset,
  density: _density,
  ...props
}: Omit<ComponentProps<typeof DropdownSubTrigger>, 'label' | 'index'> & {
  label?: string;
  index?: number;
  inset?: boolean;
  density?: 'default' | 'touch';
}) {
  return (
    <DropdownSubTrigger
      {...props}
      index={index}
      label={label ?? labelText(children)}
      labelContent={children}
      data-slot="menu-sub-trigger"
    />
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
};
