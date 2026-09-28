import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Empty, Field, Icon, Modal } from '../components/ui';
import { List, Meal, Recipe, Slot, api, qs } from '../lib/api';
import { addDaysYmd, fmtDayShort, fmtWeekday, parseYmd, startOfWeek, today, ymd } from '../lib/dates';
import { useAction, useToast } from '../lib/hooks';

const SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const SLOT_LABEL: Record<Slot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

export function MealsPage() {
  const [tab, setTab] = useState<'plan' | 'recipes'>('plan');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Meals</h1>
        <div className="seg">
          <button className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>Week plan</button>
          <button className={tab === 'recipes' ? 'on' : ''} onClick={() => setTab('recipes')}>Recipes</button>
        </div>
      </header>
      {tab === 'plan' ? <WeekPlan /> : <Recipes />}
    </div>
  );
}

function useShoppingLists() {
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<List[]>('/lists') });
  return (lists.data ?? []).filter((l) => l.kind === 'shopping');
}

function WeekPlan() {
  const toast = useToast();
  const [weekStart, setWeekStart] = useState(ymd(startOfWeek(new Date())));
  const weekEnd = addDaysYmd(weekStart, 6);
  const meals = useQuery({ queryKey: ['meals', weekStart, weekEnd], queryFn: () => api<Meal[]>(`/meals${qs({ start: weekStart, end: weekEnd })}`) });
  const [editing, setEditing] = useState<{ meal?: Meal; date: string; slot: Slot } | null>(null);
  const shopping = useShoppingLists();
  const [listId, setListId] = useState('');
  const targetList = listId || shopping[0]?.id;
  const toList = useAction(
    () => api<{ added: number }>('/meals/to-list', 'POST', { start: weekStart, end: weekEnd, listId: targetList }),
    [['items'], ['lists']],
    (r) => toast(r.added ? `Added ${r.added} ingredient${r.added === 1 ? '' : 's'} to the list` : 'No recipe ingredients to add this week', 'success'),
  );
  const t = today();
  const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStart, i));
  const slotsShown: Slot[] = (meals.data ?? []).some((m) => m.slot === 'snack') ? SLOTS : ['breakfast', 'lunch', 'dinner'];

  return (
    <>
      <div className="toolbar">
        <div className="date-nav">
          <button className="icon-btn" onClick={() => setWeekStart(addDaysYmd(weekStart, -7))} aria-label="Previous week"><Icon name="left" /></button>
          <button className="btn btn-sm" onClick={() => setWeekStart(ymd(startOfWeek(new Date())))}>
            {fmtDayShort(weekStart)} – {fmtDayShort(weekEnd)}
          </button>
          <button className="icon-btn" onClick={() => setWeekStart(addDaysYmd(weekStart, 7))} aria-label="Next week"><Icon name="right" /></button>
        </div>
        <span className="spacer" />
        {shopping.length > 1 && (
          <select className="input input-sm" value={targetList} onChange={(e) => setListId(e.target.value)}>
            {shopping.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
        <button className="btn" disabled={!targetList || toList.isPending} onClick={() => toList.mutate()}>
          <Icon name="cart" size={16} /> Add week's ingredients to list
        </button>
      </div>

      <div className="meal-grid" style={{ ['--slots' as any]: slotsShown.length }}>
        <div className="meal-grid-head" />
        {slotsShown.map((s) => (
          <div key={s} className="meal-grid-head">{SLOT_LABEL[s]}</div>
        ))}
        {days.map((d) => (
          <div key={d} className="meal-grid-row">
            <div className={`meal-day ${d === t ? 'is-today' : ''}`}>
              <div className="meal-day-wd">{fmtWeekday(d)}</div>
              <div className="meal-day-num">{parseYmd(d).getDate()}</div>
            </div>
            {slotsShown.map((s) => {
              const cell = (meals.data ?? []).filter((m) => m.date === d && m.slot === s);
              return (
                <div key={s} className="meal-cell">
                  <span className="meal-cell-label">{SLOT_LABEL[s]}</span>
                  {cell.map((m) => (
                    <button key={m.id} className={`meal-chip ${m.recipeId ? 'has-recipe' : ''}`} onClick={() => setEditing({ meal: m, date: d, slot: s })}>
                      {m.recipeTitle ?? m.title}
                    </button>
                  ))}
                  <button className="meal-add" onClick={() => setEditing({ date: d, slot: s })} aria-label={`Add ${s} on ${d}`}>
                    <Icon name="plus" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {editing && <MealModal {...editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MealModal({ meal, date, slot, onClose }: { meal?: Meal; date: string; slot: Slot; onClose: () => void }) {
  const recipes = useQuery({ queryKey: ['recipes'], queryFn: () => api<Recipe[]>('/recipes') });
  const [d, setD] = useState(meal?.date ?? date);
  const [s, setS] = useState<Slot>(meal?.slot ?? slot);
  const [recipeId, setRecipeId] = useState(meal?.recipeId ?? '');
  const [title, setTitle] = useState(meal?.title ?? '');
  const [notes, setNotes] = useState(meal?.notes ?? '');
  const body = () => ({ date: d, slot: s, recipeId: recipeId || null, title: recipeId ? null : title || null, notes: notes || null });
  const save = useAction(() => (meal ? api(`/meals/${meal.id}`, 'PUT', body()) : api('/meals', 'POST', body())), [['meals']], onClose);
  const del = useAction(() => api(`/meals/${meal!.id}`, 'DELETE'), [['meals']], onClose);
  return (
    <Modal
      title={meal ? 'Edit meal' : 'Plan a meal'}
      onClose={onClose}
      footer={
        <>
          {meal && (
            <button className="btn btn-danger-ghost" onClick={() => del.mutate()}>
              <Icon name="trash" size={16} /> Remove
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!recipeId && !title.trim()} onClick={() => save.mutate()}>Save</button>
        </>
      }
    >
      <div className="form">
        <div className="grid-2">
          <Field label="Day">
            <input className="input" type="date" value={d} onChange={(e) => setD(e.target.value)} />
          </Field>
          <Field label="Meal">
            <select className="input" value={s} onChange={(e) => setS(e.target.value as Slot)}>
              {SLOTS.map((x) => (
                <option key={x} value={x}>{SLOT_LABEL[x]}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Recipe">
          <select className="input" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">— No recipe, just a name —</option>
            {(recipes.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
        </Field>
        {!recipeId && (
          <Field label="What's cooking?">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Taco night, Leftovers, Eat out" />
          </Field>
        )}
        <Field label="Notes">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function Recipes() {
  const recipes = useQuery({ queryKey: ['recipes'], queryFn: () => api<Recipe[]>('/recipes') });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Recipe | 'new' | null>(null);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (recipes.data ?? []).filter((r) => !s || r.title.toLowerCase().includes(s) || r.tags.some((t) => t.toLowerCase().includes(s)));
  }, [recipes.data, search]);
  return (
    <>
      <div className="toolbar">
        <input className="input" placeholder="Search recipes or tags" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn btn-primary" onClick={() => setOpen('new')}>
          <Icon name="plus" size={16} /> New recipe
        </button>
      </div>
      {filtered.length === 0 && !recipes.isLoading && <Empty icon="📖" title={search ? 'No matches' : 'Your recipe box is empty'}>Add family favourites to plan meals faster.</Empty>}
      <div className="recipe-grid">
        {filtered.map((r) => (
          <button key={r.id} className="card recipe-card" onClick={() => setOpen(r)}>
            <div className="recipe-title">{r.title}</div>
            <div className="muted small">
              {r.ingredients.length} ingredients{r.prepMinutes ? ` · ${r.prepMinutes} min` : ''}
              {r.servings ? ` · serves ${r.servings}` : ''}
            </div>
            {r.tags.length > 0 && (
              <div className="chip-row">
                {r.tags.map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
      {open && <RecipeModal recipe={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RecipeModal({ recipe, onClose }: { recipe: Recipe | null; onClose: () => void }) {
  const toast = useToast();
  const shopping = useShoppingLists();
  const [editMode, setEditMode] = useState(!recipe);
  const [title, setTitle] = useState(recipe?.title ?? '');
  const [ingredients, setIngredients] = useState((recipe?.ingredients ?? []).join('\n'));
  const [instructions, setInstructions] = useState(recipe?.instructions ?? '');
  const [sourceUrl, setSourceUrl] = useState(recipe?.sourceUrl ?? '');
  const [servings, setServings] = useState(recipe?.servings?.toString() ?? '');
  const [prep, setPrep] = useState(recipe?.prepMinutes?.toString() ?? '');
  const [tags, setTags] = useState((recipe?.tags ?? []).join(', '));
  const body = () => ({
    title,
    ingredients: ingredients.split('\n').map((s) => s.trim()).filter(Boolean),
    instructions: instructions || null,
    sourceUrl: sourceUrl || null,
    servings: servings ? Number(servings) : null,
    prepMinutes: prep ? Number(prep) : null,
    tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
  });
  const save = useAction(() => (recipe ? api(`/recipes/${recipe.id}`, 'PUT', body()) : api('/recipes', 'POST', body())), [['recipes'], ['meals']], onClose);
  const del = useAction(() => api(`/recipes/${recipe!.id}`, 'DELETE'), [['recipes'], ['meals']], onClose);
  const toList = useAction(
    () => api<{ added: number }>(`/recipes/${recipe!.id}/to-list`, 'POST', { listId: shopping[0]?.id }),
    [['items'], ['lists']],
    (r) => toast(`Added ${r.added} item${r.added === 1 ? '' : 's'} to ${shopping[0]?.name}`, 'success'),
  );

  if (recipe && !editMode) {
    return (
      <Modal
        title={recipe.title}
        onClose={onClose}
        wide
        footer={
          <>
            <button className="btn" onClick={() => setEditMode(true)}><Icon name="edit" size={16} /> Edit</button>
            <span className="spacer" />
            {shopping.length > 0 && recipe.ingredients.length > 0 && (
              <button className="btn btn-primary" onClick={() => toList.mutate()} disabled={toList.isPending}>
                <Icon name="cart" size={16} /> Add ingredients to {shopping[0].name}
              </button>
            )}
          </>
        }
      >
        <div className="recipe-view">
          <div className="muted small">
            {[recipe.servings && `Serves ${recipe.servings}`, recipe.prepMinutes && `${recipe.prepMinutes} min`].filter(Boolean).join(' · ')}
            {recipe.sourceUrl && (
              <>
                {' · '}
                <a href={recipe.sourceUrl} target="_blank" rel="noreferrer">Source</a>
              </>
            )}
          </div>
          <h3>Ingredients</h3>
          <ul>{recipe.ingredients.map((i, n) => <li key={n}>{i}</li>)}</ul>
          {recipe.instructions && (
            <>
              <h3>Instructions</h3>
              <p className="pre">{recipe.instructions}</p>
            </>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={recipe ? 'Edit recipe' : 'New recipe'}
      onClose={onClose}
      wide
      footer={
        <>
          {recipe && (
            <button className="btn btn-danger-ghost" onClick={() => confirm('Delete this recipe?') && del.mutate()}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        </>
      }
    >
      <div className="form">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid-3">
          <Field label="Serves">
            <input className="input" type="number" min={1} value={servings} onChange={(e) => setServings(e.target.value)} />
          </Field>
          <Field label="Minutes">
            <input className="input" type="number" min={0} value={prep} onChange={(e) => setPrep(e.target.value)} />
          </Field>
          <Field label="Tags">
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="quick, kids" />
          </Field>
        </div>
        <Field label="Ingredients" hint="One per line. These go straight to your shopping list.">
          <textarea className="input" rows={7} value={ingredients} onChange={(e) => setIngredients(e.target.value)} />
        </Field>
        <Field label="Instructions">
          <textarea className="input" rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <Field label="Source link">
          <input className="input" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
        </Field>
      </div>
    </Modal>
  );
}
